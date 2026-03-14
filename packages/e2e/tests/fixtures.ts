/**
 * Test Fixtures for Holochain Web Conductor E2E Tests
 *
 * Provides shared setup for tests including:
 * - Browser context with extension loaded
 * - Environment state access
 * - Helper functions for common operations
 */

import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import { chromium, firefox } from 'playwright';
import { withExtension } from 'playwright-webextext';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFile } from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const SANDBOX_DIR = '/tmp/hwc-e2e';
// Use HTTP URL to avoid file:// issues with Chrome extension signal delivery
const TEST_PAGE_URL = 'http://localhost:3333/e2e-linker-test.html';
const USER_DATA_DIR = join(PROJECT_ROOT, '.playwright-user-data');

/** Target browser: 'chrome' (default) or 'firefox' */
export type TargetBrowser = 'chrome' | 'firefox';

function getTargetBrowser(): TargetBrowser {
  const env = process.env.BROWSER?.toLowerCase();
  if (env === 'firefox') return 'firefox';
  return 'chrome';
}

function getExtensionPath(browser: TargetBrowser): string {
  const distDir = browser === 'firefox' ? 'dist-firefox' : 'dist-chrome';
  return join(PROJECT_ROOT, 'packages', 'extension', distDir);
}

export interface HwcFixtures {
  /** Browser context with extension loaded */
  extensionContext: BrowserContext;
  /** Extension ID */
  extensionId: string;
  /** Test page for interacting with extension */
  testPage: Page;
  /** Linker URL from environment */
  linkerUrl: string;
  /** DNA hash from sandbox */
  dnaHash: string | null;
  /** App ID from sandbox */
  appId: string | null;
  /** Path to hApp file */
  happPath: string | null;
}

/**
 * Launch a browser with the HWC extension loaded.
 * Chrome: uses chromium.launchPersistentContext with --load-extension args
 * Firefox: uses playwright-webextext to install via remote debugging protocol
 */
async function launchBrowserWithExtension(
  browser: TargetBrowser,
  extensionPath: string,
  userDataDir: string,
  extraArgs: string[] = [],
): Promise<BrowserContext> {
  if (browser === 'firefox') {
    const firefoxWithExt = withExtension(firefox, extensionPath);
    return firefoxWithExt.launchPersistentContext(userDataDir, {
      headless: false,
      args: extraArgs,
      // Disable IDB migration so the extension reads from the legacy JSON
      // storage format (browser-extension-data/), allowing us to pre-populate
      // permissions before launch.
      firefoxUserPrefs: {
        'extensions.webextensions.ExtensionStorageIDB.migrated.holochain@holo.host': false,
      },
    });
  }
  return chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-first-run',
      '--disable-default-apps',
      ...extraArgs,
    ],
  });
}

/**
 * Get extension ID from the browser context.
 * Chrome: extracts from service worker URL (chrome-extension://ID/)
 * Firefox: extracts from background page URL (moz-extension://UUID/)
 */
async function getExtensionId(context: BrowserContext): Promise<string> {
  const page = await context.newPage();
  let extensionId = '';
  let attempts = 0;
  const maxAttempts = 50;

  while (!extensionId && attempts < maxAttempts) {
    // Chrome: check service workers
    for (const worker of context.serviceWorkers()) {
      const match = worker.url().match(/chrome-extension:\/\/([a-z]{32})\//);
      if (match) {
        extensionId = match[1];
        break;
      }
    }

    // Firefox: check background pages (event pages)
    if (!extensionId) {
      for (const bg of context.backgroundPages()) {
        const match = bg.url().match(/moz-extension:\/\/([^/]+)\//);
        if (match) {
          extensionId = match[1];
          break;
        }
      }
    }

    // Firefox fallback: check all pages for moz-extension:// URLs
    if (!extensionId) {
      for (const p of context.pages()) {
        const match = p.url().match(/moz-extension:\/\/([^/]+)\//);
        if (match) {
          extensionId = match[1];
          break;
        }
      }
    }

    if (!extensionId) {
      await page.waitForTimeout(200);
      attempts++;
    }
  }

  await page.close();

  if (!extensionId) {
    console.warn('Could not find extension ID after polling');
  }

  return extensionId;
}

/**
 * Read sandbox state files
 */
async function readSandboxState(): Promise<{
  dnaHash: string | null;
  appId: string | null;
  happPath: string | null;
}> {
  let dnaHash: string | null = null;
  let appId: string | null = null;
  let happPath: string | null = null;

  try {
    dnaHash = (await readFile(join(SANDBOX_DIR, 'dna_hash.txt'), 'utf-8')).trim();
  } catch {}

  try {
    appId = (await readFile(join(SANDBOX_DIR, 'app_id.txt'), 'utf-8')).trim();
  } catch {}

  try {
    happPath = (await readFile(join(SANDBOX_DIR, 'happ_path.txt'), 'utf-8')).trim();
  } catch {}

  return { dnaHash, appId, happPath };
}

/**
 * Set up auto-approval for authorization popups
 */
function setupAutoApproval(context: BrowserContext): void {
  context.on('page', async (page) => {
    try {
      // On Firefox, the page URL may be about:blank when the event fires.
      // Wait for the page to finish its initial navigation before checking.
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      let url = page.url();

      // If still about:blank, wait briefly for the real navigation
      if (url === 'about:blank') {
        await page.waitForURL((u) => u.toString() !== 'about:blank', { timeout: 5000 }).catch(() => {});
        url = page.url();
      }

      if (url.includes('authorize.html')) {
        console.log('[E2E] Authorization popup detected, auto-approving...');
        await page.waitForSelector('#approve-btn', { timeout: 5000 });
        await page.click('#approve-btn');
        console.log('[E2E] Clicked approve button');
      }
    } catch (err) {
      console.error('[E2E] Failed to auto-approve:', err);
    }
  });
}

/**
 * Pre-populate Firefox extension storage with pre-approved origins.
 *
 * On Firefox, the authorization popup opened by chrome.windows.create() is
 * invisible to Playwright (not in context.pages()), so we can't auto-approve it.
 * Instead, we pre-populate the extension's chrome.storage.local data using
 * Firefox's legacy JSON storage format (browser-extension-data/).
 *
 * This must be called BEFORE launching the browser. We also set the
 * `extensions.webextensions.ExtensionStorageIDB.migrated.holochain@holo.host`
 * pref to false so Firefox uses the JSON storage instead of IndexedDB.
 *
 * @param userDataDir - Firefox profile directory
 * @param origins - origins to pre-approve (e.g. ['http://localhost:8082'])
 */
async function preApproveOriginsInProfile(
  userDataDir: string,
  origins: string[],
): Promise<void> {
  const { mkdir, writeFile } = await import('fs/promises');
  const addonId = 'holochain@holo.host';
  const storageDir = join(userDataDir, 'browser-extension-data', addonId);
  await mkdir(storageDir, { recursive: true });

  const permissions: Record<string, any> = {};
  for (const origin of origins) {
    permissions[origin] = {
      origin,
      granted: true,
      timestamp: Date.now(),
    };
  }

  const storageData = {
    hwc_permissions: {
      permissions,
      version: 1,
    },
  };

  await writeFile(join(storageDir, 'storage.js'), JSON.stringify(storageData));
  console.log(`[E2E] Pre-approved ${origins.length} origins in Firefox profile storage`);
}

/**
 * Extended test with HWC fixtures
 */
export const test = base.extend<HwcFixtures>({
  extensionContext: async ({}, use) => {
    const browser = getTargetBrowser();
    const extensionPath = getExtensionPath(browser);
    const context = await launchBrowserWithExtension(browser, extensionPath, USER_DATA_DIR);

    // Set up auto-approval for authorization popups
    setupAutoApproval(context);

    await use(context);
    await context.close();
  },

  extensionId: async ({ extensionContext }, use) => {
    const id = await getExtensionId(extensionContext);
    await use(id);
  },

  testPage: async ({ extensionContext }, use) => {
    const page = await extensionContext.newPage();
    await page.goto(TEST_PAGE_URL);
    // Wait for extension to be detected
    await page.waitForFunction(() => (window as any).holochain?.isWebConductor, {
      timeout: 10000,
    });
    await use(page);
    await page.close();
  },

  linkerUrl: async ({}, use) => {
    const url = process.env.LINKER_URL ?? 'http://localhost:8000';
    await use(url);
  },

  dnaHash: async ({}, use) => {
    const { dnaHash } = await readSandboxState();
    await use(dnaHash);
  },

  appId: async ({}, use) => {
    const { appId } = await readSandboxState();
    await use(appId);
  },

  happPath: async ({}, use) => {
    const { happPath } = await readSandboxState();
    await use(happPath);
  },
});

export { expect };

/**
 * Helper to connect to extension and configure linker
 */
export async function connectAndConfigure(
  page: Page,
  linkerUrl: string
): Promise<void> {
  await page.evaluate(async (url) => {
    const holochain = (window as any).holochain;
    await holochain.connect();
    if (url) {
      await holochain.configureNetwork({ linkerUrl: url });
    }
  }, linkerUrl);
}

/**
 * Helper to install hApp from file
 */
export async function installHapp(
  page: Page,
  happPath: string,
  appId: string = 'ziptest'
): Promise<any> {
  const happBytes = await readFile(happPath);
  const happArray = Array.from(happBytes);

  return page.evaluate(
    async ({ bundle, installedAppId }) => {
      const holochain = (window as any).holochain;
      return holochain.installApp({ bundle, installedAppId });
    },
    { bundle: happArray, installedAppId: appId }
  );
}

/**
 * Helper to ensure hApp is installed, installing if needed
 */
export async function ensureHappInstalled(
  page: Page,
  happPath: string | null,
  appId: string = 'ziptest'
): Promise<boolean> {
  // Check if already installed
  const hasApp = await page.evaluate(async (appId) => {
    const holochain = (window as any).holochain;
    try {
      const info = await holochain.appInfo(appId);
      return info?.cells?.length > 0;
    } catch {
      return false;
    }
  }, appId);

  if (hasApp) {
    console.log(`[E2E] hApp ${appId} already installed`);
    return true;
  }

  // Need to install
  if (!happPath) {
    console.log('[E2E] No hApp path available, cannot install');
    return false;
  }

  console.log(`[E2E] Installing hApp from ${happPath}...`);
  try {
    await installHapp(page, happPath, appId);
    console.log(`[E2E] hApp ${appId} installed successfully`);
    return true;
  } catch (err) {
    console.error('[E2E] Failed to install hApp:', err);
    return false;
  }
}

/**
 * Helper to call a zome function
 */
export async function callZome(
  page: Page,
  params: {
    zomeName: string;
    fnName: string;
    payload?: any;
    appId?: string;
  }
): Promise<any> {
  const { zomeName, fnName, payload, appId = 'ziptest' } = params;

  return page.evaluate(
    async ({ zomeName, fnName, payload, appId }) => {
      const holochain = (window as any).holochain;
      const appInfo = await holochain.appInfo(appId);
      if (!appInfo?.cells?.[0]) {
        throw new Error('No app installed');
      }
      const cellId = appInfo.cells[0];
      return holochain.callZome({
        cell_id: cellId,
        zome_name: zomeName,
        fn_name: fnName,
        payload,
        provenance: cellId[1],
      });
    },
    { zomeName, fnName, payload, appId }
  );
}

/**
 * Poll a zome call until the check function returns true.
 * Useful for waiting until data propagates across agents.
 *
 * @param check - function that receives the zome call result and returns true when satisfied
 * @param interval - poll interval in ms (default 3000)
 * @param timeout - total timeout in ms (default 120000)
 * @returns the zome call result that satisfied the check
 */
export async function pollCallZome<T = any>(
  page: Page,
  params: {
    zomeName: string;
    fnName: string;
    payload?: any;
    appId?: string;
  },
  check: (result: T) => boolean,
  timeout = 120000,
  interval = 3000,
): Promise<T> {
  const startTime = Date.now();
  let lastResult: T | undefined;
  let lastError: string | undefined;

  while (Date.now() - startTime < timeout) {
    try {
      lastResult = await callZome(page, params);
      if (check(lastResult as T)) {
        return lastResult as T;
      }
    } catch (e: any) {
      lastError = e.message?.substring(0, 200);
    }
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[pollCallZome] ${params.fnName}: ${elapsed}s elapsed, not satisfied yet`);
    await page.waitForTimeout(interval);
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  throw new Error(
    `pollCallZome timeout after ${elapsed}s for ${params.fnName}. ` +
    `Last result: ${JSON.stringify(lastResult)?.substring(0, 200)}` +
    (lastError ? `, last error: ${lastError}` : '')
  );
}

/**
 * Helper to decode base64 hash to bytes
 */
export function decodeHashFromB64(hashStr: string): number[] {
  let b64 = hashStr;
  if (b64.startsWith('u')) {
    b64 = b64.substring(1);
  }
  b64 = b64.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) {
    b64 += '=';
  }
  const binary = atob(b64);
  return Array.from(binary).map((c) => c.charCodeAt(0));
}

/**
 * Helper to encode bytes to base64 hash
 */
export function encodeHashToB64(bytes: number[]): string {
  const binary = String.fromCharCode(...bytes);
  let b64 = btoa(binary);
  b64 = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return 'u' + b64;
}

// ============================================================================
// Multi-Agent Testing Helpers (for ziptest and similar multi-agent scenarios)
// ============================================================================

import { existsSync, rmSync } from 'fs';

const ZIPTEST_UI_URL = 'http://localhost:8081';

/**
 * Agent context containing a browser context and page for a single agent
 */
export interface AgentContext {
  name: string;
  context: BrowserContext;
  page: Page;
  userDataDir: string;
  extensionId: string;
}

/**
 * Create a persistent browser context for an agent with the extension loaded.
 * Each agent gets its own user data directory for isolated IndexedDB storage.
 * @param agentName - unique name for this agent (used for user data dir)
 * @param browser - 'chrome' or 'firefox' (defaults to BROWSER env var, then 'chrome')
 */
export async function createAgentContext(
  agentName: string,
  browser?: TargetBrowser,
): Promise<AgentContext> {
  const targetBrowser = browser ?? getTargetBrowser();
  const extensionPath = getExtensionPath(targetBrowser);
  const userDataDir = join(PROJECT_ROOT, `.playwright-user-data-${agentName}`);

  // Clean up any existing user data to start fresh
  if (existsSync(userDataDir)) {
    rmSync(userDataDir, { recursive: true, force: true });
  }

  // Pre-approve test origins in the Firefox profile BEFORE launching the browser.
  // This writes to the legacy JSON storage format that Firefox reads on startup.
  if (targetBrowser === 'firefox') {
    await preApproveOriginsInProfile(userDataDir, [
      'http://localhost:3333',
      'http://localhost:8081',
      'http://localhost:8082',
    ]);
  }

  // Chrome-specific args; Firefox ignores unknown args but keep it clean
  const extraArgs = targetBrowser === 'chrome'
    ? ['--disable-sync', '--disable-background-networking']
    : [];
  const context = await launchBrowserWithExtension(
    targetBrowser,
    extensionPath,
    userDataDir,
    extraArgs,
  );

  // Set up auto-approval for extension permission dialogs
  setupAutoApproval(context);

  // Get extension ID. For Chrome, poll service workers. For Firefox, the ID
  // can't be discovered via Playwright APIs, and the 10s polling would cause
  // the MV3 event page to suspend due to inactivity. Skip it for Firefox.
  let extensionId = '';
  if (targetBrowser === 'chrome') {
    console.log(`[${agentName}] Waiting for extension (${targetBrowser})...`);
    try {
      extensionId = await getExtensionId(context);
      console.log(`[${agentName}] Extension ready: ${extensionId}`);
    } catch {
      console.warn(`[${agentName}] Could not find extension ID`);
    }
  } else {
    console.log(`[${agentName}] Firefox: skipping extension ID polling (not discoverable)`);
  }

  const page = await context.newPage();

  // Capture browser console output for debugging
  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();
    // Filter out noisy messages
    if (text.includes('[HMR]') || text.includes('[vite]')) return;
    console.log(`[${agentName}:${type}] ${text}`);
  });

  return {
    name: agentName,
    context,
    page,
    userDataDir,
    extensionId,
  };
}

/**
 * Clean up an agent context
 */
export async function cleanupAgentContext(agent: AgentContext): Promise<void> {
  try {
    await agent.context.close();
  } catch {
    // Ignore close errors
  }
}

/**
 * Wait for the extension to be ready by checking for the holochain API
 */
export async function waitForExtensionReady(page: Page, timeout = 10000): Promise<void> {
  await page.waitForFunction(
    () => (window as any).holochain?.isWebConductor === true,
    { timeout }
  );
}

/**
 * Inject a MutationObserver that auto-clicks "Retry" buttons from the
 * connectWithJoiningUI overlay. On Firefox, the event page may be suspended
 * when the content script first tries to connect, causing holochain.connect()
 * to fail. The overlay shows a Retry button which we auto-click so the
 * retry happens without manual intervention.
 */
export async function setupAutoRetry(page: Page, agentName: string): Promise<void> {
  await page.evaluate((name) => {
    const observer = new MutationObserver(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent?.trim() === 'Retry') {
          console.log(`[${name}] Auto-clicking Retry button`);
          btn.click();
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    // Store for cleanup
    (window as any).__hwcAutoRetryObserver = observer;
  }, agentName);
}

/**
 * Create a profile using the create-profile web component (shadow DOM)
 * If a profile already exists (no create-profile component), skips creation.
 */
export async function createProfile(page: Page, nickname: string): Promise<void> {
  console.log(`[createProfile] Starting for nickname: ${nickname}`);

  // Check if we're already past the profile creation screen
  // (profile might already exist from previous test run)
  const hasController = await page.$('.test-type');
  if (hasController) {
    console.log(`[createProfile] Profile already exists, skipping creation`);
    return;
  }

  // Wait for either create-profile component OR the controller (if profile exists)
  try {
    await page.waitForSelector('create-profile, .test-type', { timeout: 60000 });
  } catch {
    // Diagnostic: check what the page shows
    const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || 'empty');
    const bodyHTML = await page.evaluate(() => document.body?.innerHTML?.substring(0, 1000) || 'empty');
    console.log(`[createProfile] Page text: ${bodyText}`);
    console.log(`[createProfile] Page HTML: ${bodyHTML}`);
    console.log(`[createProfile] Neither create-profile nor controller found`);
    throw new Error('Could not find create-profile component or controller');
  }

  // Check again if controller appeared (profile already exists)
  const controllerAppeared = await page.$('.test-type');
  if (controllerAppeared) {
    console.log(`[createProfile] Profile already exists (controller visible), skipping creation`);
    return;
  }

  console.log(`[createProfile] Found create-profile component`);

  // Give the component time to fully initialize
  await page.waitForTimeout(1000);

  // sl-input is a web component with shadow DOM containing the actual input
  // We need to target the inner input element
  const innerInputLocator = page.locator('create-profile sl-input input').first();

  // Wait for the inner input to be visible
  await innerInputLocator.waitFor({ state: 'visible', timeout: 10000 });
  console.log(`[createProfile] Found inner input`);

  // Click and fill the input
  await innerInputLocator.click();
  await innerInputLocator.fill(nickname);
  console.log(`[createProfile] Filled nickname: ${nickname}`);

  // Small delay to let the component react
  await page.waitForTimeout(500);

  // Find and click the submit button - sl-button also has shadow DOM
  // We can click the sl-button directly since Playwright handles click events on custom elements
  const buttonLocator = page.locator('create-profile sl-button').first();
  await buttonLocator.waitFor({ state: 'visible', timeout: 5000 });
  await buttonLocator.click();
  console.log(`[createProfile] Clicked submit button`);

  // Wait for Controller to load (indicates profile was created)
  await page.waitForSelector('.test-type', { timeout: 60000 });
  console.log(`[createProfile] Profile created successfully`);
}

/**
 * Wait for another agent to appear in the people list.
 * Waits for at least 1 active agent (not grayed out), excluding "Everybody".
 */
export async function waitForAgentVisible(
  page: Page,
  _agentNickname: string,
  timeout = 60000
): Promise<void> {
  const startTime = Date.now();
  const pollInterval = 2000;

  while (Date.now() - startTime < timeout) {
    const state = await page.evaluate(() => {
      const persons = document.querySelectorAll('.person');
      const details: Array<{ text: string; isActive: boolean }> = [];
      let activeAgent: string | null = null;

      for (const person of persons) {
        const text = (person.textContent || '').trim();
        // Skip Everybody - check if text starts with it
        if (text.toLowerCase().startsWith('everybody')) continue;

        // .person-inactive is a direct child div that indicates inactive status
        const hasInactiveChild = !!person.querySelector('.person-inactive');
        const isActive = !hasInactiveChild;
        details.push({ text: text.substring(0, 20), isActive });

        if (isActive && !activeAgent) {
          activeAgent = text.substring(0, 20);
        }
      }

      return { activeAgent, details, totalPersons: persons.length };
    });

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const agentSummary = state.details.map(d => `${d.text}(${d.isActive ? 'ACTIVE' : 'inactive'})`).join(', ');
    console.log(`[waitForAgentVisible] ${elapsed}s: ${state.details.length} agents. ${agentSummary || 'none'}`);

    if (state.activeAgent) {
      console.log(`[waitForAgentVisible] SUCCESS: Found active agent "${state.activeAgent}" after ${elapsed}s`);
      return;
    }

    await page.waitForTimeout(pollInterval);
  }

  throw new Error(`Timeout waiting for active agent after ${timeout}ms`);
}

/**
 * Wait for an agent to become active (not grayed out)
 * Active status is determined by ping responses (30s intervals)
 * This is now the same as waitForAgentVisible since it already waits for active.
 */
export async function waitForAgentActive(
  page: Page,
  agentNickname: string,
  timeout = 120000
): Promise<void> {
  await waitForAgentVisible(page, agentNickname, timeout);
}

/**
 * Navigate to the Entries tab
 */
export async function navigateToEntries(page: Page): Promise<void> {
  await page.click('.test-type:has-text("Entries")');
  // Wait for the ThingsPane to load
  await page.waitForSelector('.send-controls', { timeout: 10000 });
}

/**
 * Navigate to the Signals tab
 */
export async function navigateToSignals(page: Page): Promise<void> {
  await page.click('.test-type:has-text("Signals")');
}

/**
 * Click on the first active agent in the people list.
 * Ignores the nickname parameter - just clicks the first non-grayed, non-Everybody agent.
 * Waits for the StreamPane to appear after clicking.
 */
export async function selectAgent(
  page: Page,
  _agentNickname: string
): Promise<void> {
  console.log('[selectAgent] Looking for active agent...');

  // Find and click the first active agent (excluding Everybody)
  const result = await page.evaluate(() => {
    const persons = document.querySelectorAll('.person');
    for (const person of persons) {
      const text = person.textContent?.trim() || '';
      // Skip the "Everybody" broadcast option
      if (text.toLowerCase().startsWith('everybody')) continue;

      const hasInactiveChild = !!person.querySelector('.person-inactive');
      if (!hasInactiveChild) {
        (person as HTMLElement).click();
        return { clicked: true, agent: text.substring(0, 20) };
      }
    }
    return { clicked: false, agent: null };
  });

  if (!result.clicked) {
    throw new Error('No active agent found (excluding Everybody)');
  }
  console.log(`[selectAgent] Clicked on agent: ${result.agent}`);

  // Wait for the StreamPane to appear (contains .send-controls)
  console.log('[selectAgent] Waiting for StreamPane to load...');
  await page.waitForSelector('.send-controls', { timeout: 10000 });
  console.log('[selectAgent] StreamPane loaded');
}

/**
 * Create a new entry test with specified parameters.
 * Sets Count input (2nd sl-input in .send-controls) then clicks New Test.
 */
export async function createEntryTest(
  page: Page,
  options: { count?: number } = {}
): Promise<void> {
  const { count = 10 } = options;

  console.log(`[createEntryTest] Setting count to ${count}...`);

  // The inputs in .send-controls are: Reps (0), Count (1), Delay (2)
  // Set the Count input (index 1)
  await page.evaluate((countValue) => {
    const sendControls = document.querySelector('.send-controls');
    if (!sendControls) throw new Error('No .send-controls found');

    const inputs = sendControls.querySelectorAll('sl-input');
    if (inputs.length < 2) throw new Error(`Only ${inputs.length} inputs found`);

    // Count is the 2nd input (index 1)
    const countInput = inputs[1] as any;
    countInput.value = String(countValue);
  }, count);

  console.log('[createEntryTest] Clicking New Test button...');

  // Check if button is visible
  const buttonVisible = await page.isVisible('sl-button:has-text("New Test")');
  console.log(`[createEntryTest] New Test button visible: ${buttonVisible}`);

  if (!buttonVisible) {
    // Debug: show what buttons are available
    const buttons = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('sl-button')).map(b => b.textContent?.trim());
    });
    console.log('[createEntryTest] Available buttons:', buttons);
  }

  // Click New Test button
  await page.click('sl-button:has-text("New Test")');
  console.log('[createEntryTest] Clicked New Test');

  // Wait for test to appear in the list
  console.log('[createEntryTest] Waiting for test to appear...');
  await page.waitForSelector('.bunch-item', { timeout: 30000 });
  console.log('[createEntryTest] Test created');
}

/**
 * Select a test from the test list by creator name and wait for details to load.
 * Handles toggle behavior - if already selected, doesn't click again.
 * @param creatorName - The nickname of the test creator to match
 */
export async function selectTest(page: Page, creatorName: string): Promise<void> {
  console.log(`[selectTest] Looking for test created by "${creatorName}"...`);

  // Find and click the LATEST test by the creator (unless already selected)
  const result = await page.evaluate((name) => {
    const items = document.querySelectorAll('.bunch-item');
    let latestItem: Element | null = null;
    let latestTimestamp = '';

    for (const item of items) {
      const text = item.textContent || '';
      // Test names are formatted as "nickname:timestamp"
      if (text.toLowerCase().startsWith(name.toLowerCase() + ':')) {
        // Extract timestamp (everything after the first colon)
        const timestamp = text.substring(text.indexOf(':') + 1).trim();
        if (timestamp > latestTimestamp) {
          latestTimestamp = timestamp;
          latestItem = item;
        }
      }
    }

    if (latestItem) {
      const text = latestItem.textContent || '';
      const isSelected = latestItem.classList.contains('selected');
      if (!isSelected) {
        (latestItem as HTMLElement).click();
        return { success: true, clicked: true, text: text.substring(0, 50) };
      } else {
        return { success: true, clicked: false, text: text.substring(0, 50), alreadySelected: true };
      }
    }

    // Return list of available tests for debugging
    const available = Array.from(items).map(i => i.textContent?.substring(0, 30));
    return { success: false, available };
  }, creatorName);

  if (!result.success) {
    throw new Error(`No test found created by "${creatorName}". Available: ${JSON.stringify((result as any).available)}`);
  }

  if ((result as any).alreadySelected) {
    console.log(`[selectTest] Test already selected: ${(result as any).text}`);
  } else {
    console.log(`[selectTest] Clicked test: ${(result as any).text}`);
  }

  // Wait for Bunch details to load
  console.log(`[selectTest] Waiting for bunch details to load...`);

  // Debug: check what's on the page
  const pageState = await page.evaluate(() => {
    return {
      hasBunchContent: !!document.querySelector('.bunch-content'),
      hasBunch: !!document.querySelector('.bunch'),
      bunchItems: document.querySelectorAll('.bunch-item').length,
      selectedItem: document.querySelector('.bunch-item.selected')?.textContent?.substring(0, 30)
    };
  });
  console.log(`[selectTest] Page state:`, pageState);

  await page.waitForSelector('.bunch-content', { timeout: 30000 });

  // Also wait for loading skeleton to disappear
  await page.waitForFunction(
    () => !document.querySelector('.bunch-content sl-skeleton'),
    { timeout: 30000 }
  );
  console.log(`[selectTest] Bunch details loaded`);
}

/**
 * Start running a test (as the test creator)
 */
export async function startTest(page: Page): Promise<void> {
  console.log('[startTest] Waiting for Start Test button...');

  // Debug: Log what's in the bunch content
  const bunchContent = await page.evaluate(() => {
    const content = document.querySelector('.bunch-content');
    return {
      text: content?.textContent?.trim().substring(0, 200),
      buttons: Array.from(document.querySelectorAll('.bunch-content sl-button')).map(b => b.textContent?.trim())
    };
  });
  console.log('[startTest] Bunch content:', bunchContent);

  await page.waitForSelector('sl-button:has-text("Start Test")', { timeout: 30000 });
  await page.click('sl-button:has-text("Start Test")');
  console.log('[startTest] Clicked Start Test');
}

/**
 * Watch a test (as an observer)
 */
export async function watchTest(page: Page): Promise<void> {
  console.log('[watchTest] Waiting for Watch Test button...');

  // Debug: Log what's in the bunch content
  const bunchContent = await page.evaluate(() => {
    const content = document.querySelector('.bunch-content');
    return {
      text: content?.textContent?.trim().substring(0, 200),
      buttons: Array.from(document.querySelectorAll('.bunch-content sl-button')).map(b => b.textContent?.trim())
    };
  });
  console.log('[watchTest] Bunch content:', bunchContent);

  await page.waitForSelector('sl-button:has-text("Watch Test")', { timeout: 30000 });
  await page.click('sl-button:has-text("Watch Test")');
  console.log('[watchTest] Clicked Watch Test');
}

/**
 * Wait for test completion message: "All X entries found after Y seconds."
 */
export async function waitForTestCompletion(page: Page, timeout = 120000): Promise<void> {
  console.log('[waitForTestCompletion] Waiting for completion...');
  await page.waitForSelector('text=/All \\d+ entries found/', { timeout });
  console.log('[waitForTestCompletion] Test completed');
}

/**
 * Start a signal test with specified parameters.
 * Assumes the Signals tab is already selected and an agent is selected.
 */
export async function startSignalTest(
  page: Page,
  options: { count?: number; delay?: number } = {}
): Promise<void> {
  const { count = 3, delay = 500 } = options;

  console.log('[startSignalTest] Starting...');

  // Fill in test parameters using position-based selection within .send-controls
  // StreamPane inputs: Count (index 0), Delay (index 1)
  await page.evaluate(({ count, delay }) => {
    const sendControls = document.querySelector('.send-controls');
    if (!sendControls) throw new Error('No .send-controls found');

    const inputs = sendControls.querySelectorAll('sl-input');
    if (inputs.length < 2) throw new Error(`Only ${inputs.length} inputs found in .send-controls`);

    // Count is index 0, Delay is index 1
    (inputs[0] as any).value = String(count);
    (inputs[1] as any).value = String(delay);
  }, { count, delay });
  console.log(`[startSignalTest] Set count=${count}, delay=${delay}`);

  // Click Start Test button
  console.log('[startSignalTest] Looking for Start Test button...');
  const buttonVisible = await page.isVisible('sl-button:has-text("Start Test")');
  console.log('[startSignalTest] Start Test button visible:', buttonVisible);

  if (!buttonVisible) {
    // List all sl-buttons for debugging
    const buttons = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('sl-button')).map(b => b.textContent?.trim());
    });
    console.log('[startSignalTest] Available buttons:', buttons);
  }

  await page.click('sl-button:has-text("Start Test")');
  console.log('[startSignalTest] Clicked Start Test button');
}

// Export URLs for tests
export { ZIPTEST_UI_URL };
export const LINKER_URL = process.env.LINKER_URL ?? 'http://localhost:8000';
export const MEWSFEED_UI_URL = `http://localhost:8082?runtime=hwc&linkerUrl=${encodeURIComponent(LINKER_URL)}`;

// ============================================================================
// Mewsfeed Testing Helpers
// ============================================================================

/**
 * Create a profile in the mewsfeed UI.
 *
 * Mewsfeed does NOT show a profile creation dialog on page load. The dialog
 * only appears when the user tries to perform an action (e.g., send a mew).
 * This helper triggers the profile dialog by clicking "Send Mew" on the inline
 * CreateMewInput on the feed page, then fills in and saves the profile.
 *
 * Note: The "Send Mew" button has DaisyUI's btn-disabled class (pointer-events: none)
 * when the mew input is empty, so we use programmatic button.click() via evaluate
 * to bypass the CSS pointer-events restriction.
 */
export async function createMewsfeedProfile(page: Page, nickname: string): Promise<void> {
  console.log(`[createMewsfeedProfile] Starting for nickname: ${nickname}`);

  // Wait for the Mew button to appear (visible on all pages)
  await page.locator('button').filter({ hasText: 'Mew' }).first()
    .waitFor({ state: 'visible', timeout: 30000 });
  console.log(`[createMewsfeedProfile] Found mew button on feed page`);

  // Type text into the mew input first so that after profile creation,
  // the app can submit a valid mew (mews must be >= 10 characters).
  const mewInput = page.locator('[data-placeholder="What\'s mewing on?"]').first();
  try {
    await mewInput.waitFor({ state: 'visible', timeout: 10000 });
    await mewInput.click();
    await page.keyboard.type(`Hello from ${nickname} on mewsfeed`, { delay: 30 });
    console.log(`[createMewsfeedProfile] Typed initial mew text`);
  } catch {
    console.log(`[createMewsfeedProfile] Could not find mew input, proceeding to click button`);
  }

  // Click the button programmatically to bypass DaisyUI btn-disabled pointer-events:none.
  const clicked = await page.evaluate(() => {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const text = btn.textContent || '';
      if (text.includes('Send') && text.includes('Mew')) {
        btn.click();
        return 'send-mew';
      }
    }
    // Fallback: any button containing "Mew"
    for (const btn of buttons) {
      if (btn.textContent?.includes('Mew')) {
        btn.click();
        return 'mew';
      }
    }
    return null;
  });
  console.log(`[createMewsfeedProfile] Triggered publishMew via ${clicked} button.click()`);

  // Wait for the profile creation dialog to appear
  // The h2 "create profile" is in light DOM inside a HeadlessUI Dialog
  const profileHeading = page.locator('h2').filter({ hasText: 'create profile' });
  try {
    await profileHeading.waitFor({ state: 'visible', timeout: 30000 });
  } catch {
    // Profile may already exist (no dialog appeared)
    console.log(`[createMewsfeedProfile] No profile dialog appeared, profile may already exist`);
    // Debug: take screenshot
    await page.screenshot({ path: '/tmp/mewsfeed-no-profile-dialog.png', fullPage: true });
    return;
  }

  console.log(`[createMewsfeedProfile] Profile creation dialog appeared`);
  await page.waitForTimeout(1000);

  // Fill the nickname field (first input[type="text"] in the dialog, which is the input-lg nickname field)
  const nicknameInput = page.locator('[role="dialog"] input[type="text"]').first();
  await nicknameInput.waitFor({ state: 'visible', timeout: 10000 });
  await nicknameInput.click();
  await nicknameInput.fill(nickname);
  console.log(`[createMewsfeedProfile] Filled nickname: ${nickname}`);

  await page.waitForTimeout(500);

  // Click the Save button inside the dialog
  const saveButton = page.locator('[role="dialog"] button').filter({ hasText: 'Save' });
  await saveButton.waitFor({ state: 'visible', timeout: 5000 });
  await saveButton.click();
  console.log(`[createMewsfeedProfile] Clicked Save`);

  // Wait for the profile dialog to close (h2 becomes hidden)
  await profileHeading.waitFor({ state: 'hidden', timeout: 60000 });
  console.log(`[createMewsfeedProfile] Profile created successfully`);
}

/**
 * Create a mew (post) in the mewsfeed UI.
 *
 * Uses the inline CreateMewInput on the feed page (desktop layout).
 * The contenteditable has data-placeholder="What's mewing on?".
 * Typing and clicking "Send Mew" publishes the mew.
 */
export async function createMew(page: Page, text: string): Promise<void> {
  console.log(`[createMew] Creating mew: "${text}"`);

  // Try inline CreateMewInput first (feed page), then fall back to + MEW dialog
  const mewInput = page.locator('[data-placeholder="What\'s mewing on?"]').first();
  try {
    await mewInput.waitFor({ state: 'visible', timeout: 30000 });
  } catch (e) {
    // Fallback: click "+ MEW" button to open the CreateMewDialog
    console.log('[createMew] Inline input not visible, trying + MEW dialog...');
    const mewButton = page.locator('button:has-text("Mew")').first();
    try {
      await mewButton.waitFor({ state: 'visible', timeout: 5000 });
      await mewButton.click();
      await page.waitForTimeout(1000);
      // Dialog should now show the CreateMewInput
      await mewInput.waitFor({ state: 'visible', timeout: 10000 });
    } catch (e2) {
      await page.screenshot({ path: '/tmp/mewsfeed-createMew-debug.png', fullPage: true });
      console.log('[createMew] Screenshot saved to /tmp/mewsfeed-createMew-debug.png');
      console.log('[createMew] Page body (first 1000):', (await page.textContent('body'))?.substring(0, 1000));
      throw e2;
    }
  }

  // Focus and type the text
  await mewInput.click();
  await page.keyboard.type(text, { delay: 50 });
  console.log(`[createMew] Typed mew text`);

  await page.waitForTimeout(500);

  // Click Send Mew button
  const sendButton = page.locator('button:has-text("Send Mew")').first();
  try {
    await sendButton.waitFor({ state: 'visible', timeout: 5000 });
    await sendButton.click();
  } catch {
    // Fallback to any Mew button
    const anyMewBtn = page.locator('button:has-text("Mew")').first();
    await anyMewBtn.click();
  }
  console.log(`[createMew] Clicked send button`);

  // Wait for the mew to be sent
  await page.waitForTimeout(5000);
  console.log(`[createMew] Mew sent`);
}

/**
 * Navigate to a hashtag page and wait for a specific mew text to appear.
 * Uses client-side Vue Router navigation (static server only serves files).
 * Polls by navigating away and back to trigger fresh data fetches.
 *
 * @param mewTextFragment - A substring to look for in the mew content (e.g. "hwc extension")
 */
export async function waitForHashtagResult(
  page: Page,
  hashtag: string,
  mewTextFragment: string,
  timeout = 120000
): Promise<void> {
  const tag = hashtag.startsWith('#') ? hashtag.substring(1) : hashtag;
  const hashtagPath = `/hashtag/${tag}`;

  console.log(`[waitForHashtagResult] Navigating to ${hashtagPath}, looking for "${mewTextFragment}"`);

  // Navigate to the hashtag route within the SPA
  await page.evaluate((path) => {
    history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, hashtagPath);

  // Wait for Vue Router to process the route change
  await page.waitForTimeout(3000);

  const startTime = Date.now();
  const pollInterval = 5000;

  while (Date.now() - startTime < timeout) {
    const bodyText = (await page.textContent('body')) || '';
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    if (bodyText.includes(mewTextFragment)) {
      console.log(`[waitForHashtagResult] Found mew with "${mewTextFragment}" for #${tag} after ${elapsed}s`);
      return;
    }

    const isEmpty = bodyText.includes('nothing here') || bodyText.includes('Nothing found');
    console.log(`[waitForHashtagResult] ${elapsed}s: empty=${isEmpty}, no match yet. body(200): ${bodyText.substring(0, 200)}`);

    await page.waitForTimeout(pollInterval);

    // Navigate away and back to trigger a fresh data fetch from the zome
    await page.evaluate(() => {
      history.pushState({}, '', '/feed');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await page.waitForTimeout(500);
    await page.evaluate((path) => {
      history.pushState({}, '', path);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, hashtagPath);
    await page.waitForTimeout(2000);
  }

  throw new Error(`Timeout waiting for "${mewTextFragment}" on #${tag} after ${timeout}ms`);
}

// ============================================================================
// Chain Recovery E2E Helpers
// ============================================================================

/**
 * Open an extension popup page (e.g., lair.html, happs.html) in a new tab.
 * Returns the page for interaction. Caller is responsible for closing it.
 */
export async function openPopupPage(
  agent: AgentContext,
  pageName: string
): Promise<Page> {
  const url = extensionUrl(agent.extensionId, `popup/${pageName}`);
  const page = await agent.context.newPage();
  await page.goto(url);
  await page.waitForLoadState('domcontentloaded');
  return page;
}

/**
 * Build a full extension URL from extension ID and path.
 * Chrome IDs are 32 lowercase letters; Firefox IDs contain hyphens (UUID format).
 */
function extensionUrl(extensionId: string, path: string): string {
  const protocol = extensionId.includes('-') ? 'moz-extension' : 'chrome-extension';
  return `${protocol}://${extensionId}/${path}`;
}

/**
 * Ensure the lair keystore is unlocked on the given lair popup page.
 * Handles three states: no passphrase set, locked, or already unlocked.
 * Uses LAIR_PASSPHRASE as a fixed passphrase for e2e tests.
 */
const LAIR_PASSPHRASE = 'e2e-test-passphrase-12345678';

async function ensureLairUnlocked(lairPage: Page, agentName: string): Promise<void> {
  // Wait for the page JS to run and update lock state
  // The lair page calls updateLockState() on DOMContentLoaded which is async
  console.log(`[${agentName}] Waiting for lair lock state to render...`);

  // Wait for one of the three state sections to become visible
  await lairPage.waitForFunction(() => {
    const setup = document.getElementById('passphrase-setup');
    const unlock = document.getElementById('unlock-section');
    const lock = document.getElementById('lock-section');
    return (setup && !setup.classList.contains('hidden')) ||
           (unlock && !unlock.classList.contains('hidden')) ||
           (lock && !lock.classList.contains('hidden'));
  }, { timeout: 15000 });

  // Debug: log current state
  const state = await lairPage.evaluate(() => {
    const setup = document.getElementById('passphrase-setup');
    const unlock = document.getElementById('unlock-section');
    const lock = document.getElementById('lock-section');
    return {
      setupVisible: setup ? !setup.classList.contains('hidden') : false,
      unlockVisible: unlock ? !unlock.classList.contains('hidden') : false,
      lockVisible: lock ? !lock.classList.contains('hidden') : false,
    };
  });
  console.log(`[${agentName}] Lair state: setup=${state.setupVisible} unlock=${state.unlockVisible} locked=${state.lockVisible}`);

  if (state.lockVisible) {
    console.log(`[${agentName}] Lair already unlocked`);
    return;
  }

  if (state.setupVisible) {
    console.log(`[${agentName}] Lair needs passphrase setup`);
    await lairPage.fill('#new-passphrase', LAIR_PASSPHRASE);
    await lairPage.click('#set-passphrase-btn');
    await lairPage.waitForFunction(() => {
      const lock = document.getElementById('lock-section');
      return lock && !lock.classList.contains('hidden');
    }, { timeout: 15000 });
    console.log(`[${agentName}] Lair passphrase set and unlocked`);
    return;
  }

  if (state.unlockVisible) {
    console.log(`[${agentName}] Lair locked, unlocking...`);
    await lairPage.fill('#unlock-passphrase', LAIR_PASSPHRASE);
    await lairPage.click('#unlock-btn');
    await lairPage.waitForFunction(() => {
      const lock = document.getElementById('lock-section');
      return lock && !lock.classList.contains('hidden');
    }, { timeout: 15000 });
    console.log(`[${agentName}] Lair unlocked`);
    return;
  }

  throw new Error(`[${agentName}] Could not determine lair lock state`);
}

/**
 * Export an agent key via the lair popup UI.
 * Returns the encrypted JSON string for later import.
 */
export async function exportAgentKey(
  agent: AgentContext,
  keyTag: string,
  passphrase: string
): Promise<string> {
  console.log(`[${agent.name}] Exporting key "${keyTag}"...`);
  const lairPage = await openPopupPage(agent, 'lair.html');

  // Capture console from lair page for debugging
  lairPage.on('console', (msg) => {
    console.log(`[${agent.name}:lair:${msg.type()}] ${msg.text()}`);
  });

  try {
    // Ensure lair is unlocked first
    await ensureLairUnlocked(lairPage, agent.name);

    // Wait for keypair list to load (refresh happens after unlock)
    await lairPage.waitForSelector('#export-keypair', { timeout: 10000 });
    await lairPage.waitForTimeout(1000);

    // Debug: log available options
    const options = await lairPage.locator('#export-keypair option').allTextContents();
    console.log(`[${agent.name}] Export keypair options: ${JSON.stringify(options)}`);

    // Select the key tag in the export dropdown
    await lairPage.selectOption('#export-keypair', keyTag);

    // Set passphrase for encrypted export
    await lairPage.fill('#export-passphrase', passphrase);

    // Click export
    await lairPage.click('#export-btn');

    // Wait for export result
    await lairPage.waitForSelector('#export-result:not(.hidden)', { timeout: 10000 });
    const encryptedJson = await lairPage.textContent('#export-result');

    if (!encryptedJson) {
      throw new Error('Export result was empty');
    }

    console.log(`[${agent.name}] Key exported (${encryptedJson.length} chars)`);
    return encryptedJson;
  } finally {
    await lairPage.close();
  }
}

/**
 * Import an agent key via the lair popup UI.
 */
export async function importAgentKey(
  agent: AgentContext,
  encryptedJson: string,
  passphrase: string,
  tag: string
): Promise<void> {
  console.log(`[${agent.name}] Importing key as "${tag}"...`);
  const lairPage = await openPopupPage(agent, 'lair.html');

  // Capture console from lair page for debugging
  lairPage.on('console', (msg) => {
    console.log(`[${agent.name}:lair-import:${msg.type()}] ${msg.text()}`);
  });

  try {
    // Ensure lair is unlocked first
    await ensureLairUnlocked(lairPage, agent.name);

    // Wait for import section to be available (not disabled)
    await lairPage.waitForSelector('#export-import-section:not(.disabled)', { timeout: 10000 });

    // Fill import fields
    await lairPage.fill('#import-data', encryptedJson);
    await lairPage.fill('#import-passphrase', passphrase);
    await lairPage.fill('#import-tag', tag);

    // Check exportable checkbox
    const isChecked = await lairPage.isChecked('#import-exportable');
    if (!isChecked) {
      await lairPage.check('#import-exportable');
    }

    // Click import
    await lairPage.click('#import-btn');

    // Wait for either success or error
    await lairPage.waitForFunction(() => {
      const success = document.getElementById('import-success');
      const error = document.getElementById('import-error');
      return (success && !success.classList.contains('hidden')) ||
             (error && !error.classList.contains('hidden'));
    }, { timeout: 15000 });

    // Check which appeared
    const errorVisible = await lairPage.locator('#import-error:not(.hidden)').isVisible().catch(() => false);
    if (errorVisible) {
      const errorText = await lairPage.textContent('#import-error') || 'unknown error';
      throw new Error(`Key import failed: ${errorText}`);
    }

    console.log(`[${agent.name}] Key imported successfully`);
  } finally {
    await lairPage.close();
  }
}

/**
 * Uninstall a hApp via the happs popup UI.
 * Handles the confirm dialog automatically.
 */
export async function uninstallHappViaPopup(agent: AgentContext): Promise<void> {
  console.log(`[${agent.name}] Uninstalling hApp via popup...`);
  const happsPage = await openPopupPage(agent, 'happs.html');

  try {
    // Wait for hApp cards to load
    await happsPage.waitForSelector('.happ-card', { timeout: 15000 });

    // Auto-accept the confirm dialog
    happsPage.on('dialog', async (dialog) => {
      console.log(`[${agent.name}] Confirm dialog: ${dialog.message()}`);
      await dialog.accept();
    });

    // Click uninstall on the first hApp
    await happsPage.click('.uninstall-btn');

    // Wait for the hApp card to disappear
    await happsPage.waitForSelector('#emptyState', { timeout: 10000 });
    console.log(`[${agent.name}] hApp uninstalled`);
  } finally {
    await happsPage.close();
  }
}

/**
 * Trigger chain recovery via the happs popup UI.
 * Waits for recovery to complete and returns the result counts.
 */
export async function triggerChainRecovery(
  agent: AgentContext,
  timeout = 120000
): Promise<{ recovered: number; failed: number }> {
  console.log(`[${agent.name}] Triggering chain recovery...`);
  const happsPage = await openPopupPage(agent, 'happs.html');

  try {
    // Wait for hApp cards to load
    await happsPage.waitForSelector('.happ-card', { timeout: 15000 });

    // Auto-accept the confirm dialog
    happsPage.on('dialog', async (dialog) => {
      console.log(`[${agent.name}] Confirm dialog: ${dialog.message()}`);
      await dialog.accept();
    });

    // Click Recover Chain button
    await happsPage.click('.recover-btn');

    // Wait for recovery modal to appear
    await happsPage.waitForSelector('#recovery-modal.active', { timeout: 10000 });
    console.log(`[${agent.name}] Recovery modal visible`);

    // Wait for completion text
    await happsPage.waitForFunction(
      () => {
        const text = document.getElementById('recovery-progress-text')?.textContent || '';
        return text.includes('Recovery complete') || text.includes('Recovery failed');
      },
      { timeout }
    );

    const progressText = await happsPage.textContent('#recovery-progress-text') || '';
    console.log(`[${agent.name}] Recovery result: ${progressText}`);

    // Parse result counts
    const match = progressText.match(/(\d+) records recovered, (\d+) failed/);
    const recovered = match ? parseInt(match[1], 10) : 0;
    const failed = match ? parseInt(match[2], 10) : 0;

    // Close modal
    const closeBtn = happsPage.locator('#recovery-close-btn');
    if (await closeBtn.isVisible()) {
      await closeBtn.click();
    }

    return { recovered, failed };
  } finally {
    await happsPage.close();
  }
}
