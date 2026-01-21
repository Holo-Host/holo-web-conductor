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
const SANDBOX_DIR = join(PROJECT_ROOT, '.hc-sandbox');
const TEST_PAGE = join(PROJECT_ROOT, 'packages', 'extension', 'test', 'e2e-gateway-test.html');
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
}> {
  let dnaHash: string | null = null;
  let knownEntryHash: string | null = null;
  let appId: string | null = null;

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

  return { dnaHash, knownEntryHash, appId };
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
    await page.goto(`file://${TEST_PAGE}`);
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
