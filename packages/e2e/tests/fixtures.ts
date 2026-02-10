/**
 * Test Fixtures for Fishy E2E Tests
 *
 * Provides shared setup for tests including:
 * - Browser context with extension loaded
 * - Environment state access
 * - Helper functions for common operations
 */

import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import { chromium } from 'playwright';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFile } from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const EXTENSION_PATH = join(PROJECT_ROOT, 'packages', 'extension', 'dist');
const SANDBOX_DIR = '/tmp/fishy-e2e';
// Use HTTP URL to avoid file:// issues with Chrome extension signal delivery
const TEST_PAGE_URL = 'http://localhost:3333/e2e-gateway-test.html';
const USER_DATA_DIR = join(PROJECT_ROOT, '.playwright-user-data');

export interface FishyFixtures {
  /** Browser context with extension loaded */
  extensionContext: BrowserContext;
  /** Extension ID */
  extensionId: string;
  /** Test page for interacting with extension */
  testPage: Page;
  /** Gateway URL from environment */
  gatewayUrl: string;
  /** DNA hash from sandbox */
  dnaHash: string | null;
  /** Known entry hash from sandbox (for fixture1) */
  knownEntryHash: string | null;
  /** App ID from sandbox */
  appId: string | null;
  /** Path to hApp file */
  happPath: string | null;
}

/**
 * Get extension ID from service workers
 */
async function getExtensionId(context: BrowserContext): Promise<string> {
  const page = await context.newPage();

  let extensionId = '';
  let attempts = 0;
  const maxAttempts = 30;

  while (!extensionId && attempts < maxAttempts) {
    const serviceWorkers = context.serviceWorkers();

    for (const worker of serviceWorkers) {
      const url = worker.url();
      const match = url.match(/chrome-extension:\/\/([a-z]{32})\//);
      if (match) {
        extensionId = match[1];
        break;
      }
    }

    if (!extensionId) {
      await page.waitForTimeout(100);
      attempts++;
    }
  }

  await page.close();

  if (!extensionId) {
    throw new Error('Could not find extension ID');
  }

  return extensionId;
}

/**
 * Read sandbox state files
 */
async function readSandboxState(): Promise<{
  dnaHash: string | null;
  knownEntryHash: string | null;
  appId: string | null;
  happPath: string | null;
}> {
  let dnaHash: string | null = null;
  let knownEntryHash: string | null = null;
  let appId: string | null = null;
  let happPath: string | null = null;

  try {
    dnaHash = (await readFile(join(SANDBOX_DIR, 'dna_hash.txt'), 'utf-8')).trim();
  } catch {}

  try {
    const knownEntry = await readFile(join(SANDBOX_DIR, 'known_entry.json'), 'utf-8');
    const parsed = JSON.parse(knownEntry);
    knownEntryHash = parsed.entry_hash;
  } catch {}

  try {
    appId = (await readFile(join(SANDBOX_DIR, 'app_id.txt'), 'utf-8')).trim();
  } catch {}

  try {
    happPath = (await readFile(join(SANDBOX_DIR, 'happ_path.txt'), 'utf-8')).trim();
  } catch {}

  return { dnaHash, knownEntryHash, appId, happPath };
}

/**
 * Set up auto-approval for authorization popups
 */
function setupAutoApproval(context: BrowserContext): void {
  context.on('page', async (page) => {
    const url = page.url();
    // Check if this is an authorization popup
    if (url.includes('authorize.html')) {
      console.log('[E2E] Authorization popup detected, auto-approving...');
      try {
        // Wait for the approve button to be visible
        await page.waitForSelector('#approve-btn', { timeout: 5000 });
        // Click approve
        await page.click('#approve-btn');
        console.log('[E2E] Clicked approve button');
      } catch (err) {
        console.error('[E2E] Failed to auto-approve:', err);
      }
    }
  });
}

/**
 * Extended test with Fishy fixtures
 */
export const test = base.extend<FishyFixtures>({
  extensionContext: async ({}, use) => {
    const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-first-run',
        '--disable-default-apps',
      ],
    });

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
    await page.waitForFunction(() => (window as any).holochain?.isFishy, {
      timeout: 10000,
    });
    await use(page);
    await page.close();
  },

  gatewayUrl: async ({}, use) => {
    const url = process.env.GATEWAY_URL ?? 'http://localhost:8000';
    await use(url);
  },

  dnaHash: async ({}, use) => {
    const { dnaHash } = await readSandboxState();
    await use(dnaHash);
  },

  knownEntryHash: async ({}, use) => {
    const { knownEntryHash } = await readSandboxState();
    await use(knownEntryHash);
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
 * Helper to connect to extension and configure gateway
 */
export async function connectAndConfigure(
  page: Page,
  gatewayUrl: string
): Promise<void> {
  await page.evaluate(async (url) => {
    const holochain = (window as any).holochain;
    await holochain.connect();
    if (url) {
      await holochain.configureNetwork({ gatewayUrl: url });
    }
  }, gatewayUrl);
}

/**
 * Helper to install hApp from file
 */
export async function installHapp(
  page: Page,
  happPath: string,
  appId: string = 'fixture1'
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
  appId: string = 'fixture1'
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
  const { zomeName, fnName, payload, appId = 'fixture1' } = params;

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
}

/**
 * Create a persistent browser context for an agent with the extension loaded.
 * Each agent gets its own user data directory for isolated IndexedDB storage.
 */
export async function createAgentContext(agentName: string): Promise<AgentContext> {
  const userDataDir = join(PROJECT_ROOT, `.playwright-user-data-${agentName}`);

  // Clean up any existing user data to start fresh
  if (existsSync(userDataDir)) {
    rmSync(userDataDir, { recursive: true, force: true });
  }

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false, // Extensions require headed mode
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-background-networking',
    ],
    viewport: { width: 1280, height: 720 },
  });

  // Set up auto-approval for extension permission dialogs
  setupAutoApproval(context);

  // Wait for extension service worker to be ready
  console.log(`[${agentName}] Waiting for extension service worker...`);
  let extensionId = '';
  let attempts = 0;
  const maxAttempts = 30;

  while (!extensionId && attempts < maxAttempts) {
    const serviceWorkers = context.serviceWorkers();
    for (const worker of serviceWorkers) {
      const url = worker.url();
      const match = url.match(/chrome-extension:\/\/([a-z]{32})\//);
      if (match) {
        extensionId = match[1];
        break;
      }
    }
    if (!extensionId) {
      await new Promise(resolve => setTimeout(resolve, 200));
      attempts++;
    }
  }

  if (!extensionId) {
    console.warn(`[${agentName}] Could not find extension ID after ${maxAttempts} attempts`);
  } else {
    console.log(`[${agentName}] Extension ready: ${extensionId}`);
  }

  const page = await context.newPage();

  return {
    name: agentName,
    context,
    page,
    userDataDir,
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
    () => (window as any).holochain?.isFishy === true,
    { timeout }
  );
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
    await page.waitForSelector('create-profile, .test-type', { timeout: 30000 });
  } catch {
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
export const MEWSFEED_UI_URL = 'http://localhost:8082';

// ============================================================================
// Mewsfeed Testing Helpers
// ============================================================================

/**
 * Create a profile in the mewsfeed UI.
 * Mewsfeed uses a custom profile creation dialog (BaseEditAgentProfileForm)
 * with standard HTML inputs (not web components).
 */
export async function createMewsfeedProfile(page: Page, nickname: string): Promise<void> {
  console.log(`[createMewsfeedProfile] Starting for nickname: ${nickname}`);

  // Wait for the profile creation dialog to appear
  // The dialog heading is "create profile" (lowercase)
  try {
    await page.waitForSelector('h2:has-text("create profile")', { timeout: 30000 });
  } catch {
    // Profile may already exist - check if we're on the main page
    const onMainPage = await page.$('button:has-text("Mew")');
    if (onMainPage) {
      console.log(`[createMewsfeedProfile] Already past profile creation, skipping`);
      return;
    }
    throw new Error('Could not find profile creation dialog or main page');
  }

  console.log(`[createMewsfeedProfile] Found profile creation dialog`);

  // Give the form time to initialize
  await page.waitForTimeout(1000);

  // Fill the nickname field (first text input in the form)
  const nicknameInput = page.locator('input[type="text"]').first();
  await nicknameInput.waitFor({ state: 'visible', timeout: 10000 });
  await nicknameInput.click();
  await nicknameInput.fill(nickname);
  console.log(`[createMewsfeedProfile] Filled nickname: ${nickname}`);

  await page.waitForTimeout(500);

  // Click the Save button
  const saveButton = page.locator('button.btn.btn-primary:has-text("Save")');
  await saveButton.waitFor({ state: 'visible', timeout: 5000 });
  await saveButton.click();
  console.log(`[createMewsfeedProfile] Clicked Save`);

  // Wait for the main layout to load (Mew button indicates we're past profile creation)
  await page.waitForSelector('button:has-text("Mew")', { timeout: 60000 });
  console.log(`[createMewsfeedProfile] Profile created, main layout loaded`);
}

/**
 * Create a mew (post) in the mewsfeed UI.
 * Opens the create mew dialog, types the text, and sends it.
 */
export async function createMew(page: Page, text: string): Promise<void> {
  console.log(`[createMew] Creating mew: "${text}"`);

  // Click the Mew button to open the create dialog
  const mewButton = page.locator('button:has-text("Mew")').first();
  await mewButton.waitFor({ state: 'visible', timeout: 10000 });
  await mewButton.click();
  console.log(`[createMew] Clicked Mew button`);

  // Wait for the contenteditable to appear
  const mewInput = page.locator('[data-placeholder="What\'s mewing on?"]');
  await mewInput.waitFor({ state: 'visible', timeout: 10000 });

  // Focus and type the text
  await mewInput.click();
  await page.keyboard.type(text, { delay: 50 });
  console.log(`[createMew] Typed mew text`);

  await page.waitForTimeout(500);

  // Click Send Mew button
  const sendButton = page.locator('button:has-text("Send Mew")');
  await sendButton.waitFor({ state: 'visible', timeout: 5000 });
  await sendButton.click();
  console.log(`[createMew] Clicked Send Mew`);

  // Wait for the dialog to close (the send button should disappear)
  await sendButton.waitFor({ state: 'hidden', timeout: 30000 });
  console.log(`[createMew] Mew sent`);
}

/**
 * Navigate to a hashtag page and wait for results to appear.
 * Polls by refreshing until mew results are visible.
 */
export async function waitForHashtagResult(
  page: Page,
  hashtag: string,
  timeout = 120000
): Promise<void> {
  // Navigate to hashtag route (strip # if present)
  const tag = hashtag.startsWith('#') ? hashtag.substring(1) : hashtag;
  const url = `${MEWSFEED_UI_URL}/hashtag/${tag}`;

  console.log(`[waitForHashtagResult] Navigating to ${url}`);
  await page.goto(url);

  const startTime = Date.now();
  const pollInterval = 5000;

  while (Date.now() - startTime < timeout) {
    // Check if any mew list items are present
    // BaseMewListItem renders as a div with cursor-pointer class containing mew content
    const hasMews = await page.evaluate(() => {
      // Look for hr.border-base-300 (dividers between mews) or mew content
      const dividers = document.querySelectorAll('hr.border-base-300');
      // Also check for any mew text content
      const mewTexts = document.querySelectorAll('.flex.flex-col.justify-start.items-start.cursor-pointer');
      return dividers.length > 0 || mewTexts.length > 0;
    });

    const elapsed = Math.round((Date.now() - startTime) / 1000);

    if (hasMews) {
      console.log(`[waitForHashtagResult] Found mews for #${tag} after ${elapsed}s`);
      return;
    }

    // Check for loading or empty state
    const state = await page.evaluate(() => {
      const loading = !!document.querySelector('.loading-spinner, sl-skeleton');
      const empty = !!document.querySelector('text=Nothing found');
      return { loading, empty };
    });

    console.log(`[waitForHashtagResult] ${elapsed}s: loading=${state.loading}, empty=${state.empty}, no mews yet`);

    // Reload the page to trigger a fresh fetch
    await page.waitForTimeout(pollInterval);
    await page.reload();
    // Wait for the page to load
    await page.waitForSelector('h1:has-text("mews with")', { timeout: 10000 }).catch(() => {});
  }

  throw new Error(`Timeout waiting for hashtag #${tag} results after ${timeout}ms`);
}
