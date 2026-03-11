/**
 * Browser Context
 *
 * Sets up Playwright browser context with the HWC extension loaded.
 * Supports both Chrome and Firefox via the BROWSER env var.
 */

import { chromium, firefox, type BrowserContext, type Page } from '@playwright/test';
import { withExtension } from 'playwright-webextext';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { access, readdir } from 'fs/promises';
import type { BrowserContextResult } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Navigate from packages/e2e/src to project root
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const USER_DATA_DIR = join(PROJECT_ROOT, '.playwright-user-data');

type TargetBrowser = 'chrome' | 'firefox';

function getTargetBrowser(): TargetBrowser {
  const env = process.env.BROWSER?.toLowerCase();
  if (env === 'firefox') return 'firefox';
  return 'chrome';
}

function getDefaultExtensionPath(browser: TargetBrowser): string {
  const distDir = browser === 'firefox' ? 'dist-firefox' : 'dist-chrome';
  return join(PROJECT_ROOT, 'packages', 'extension', distDir);
}

function extensionUrl(extensionId: string, path: string): string {
  const protocol = extensionId.includes('-') ? 'moz-extension' : 'chrome-extension';
  return `${protocol}://${extensionId}/${path}`;
}

export interface BrowserContextOptions {
  /** Path to the extension directory (auto-detected from BROWSER env var if not set) */
  extensionPath?: string;
  /** Target browser: 'chrome' or 'firefox' (defaults to BROWSER env var) */
  browser?: TargetBrowser;
  /** Whether to run headless (default: false - extensions require headed mode) */
  headless?: boolean;
  /** Slow down operations by this many milliseconds */
  slowMo?: number;
  /** Enable devtools */
  devtools?: boolean;
}

/**
 * Create a browser context with the HWC extension loaded
 */
export async function createBrowserContext(
  options: BrowserContextOptions = {}
): Promise<BrowserContextResult> {
  const targetBrowser = options.browser ?? getTargetBrowser();
  const extensionPath = options.extensionPath ?? getDefaultExtensionPath(targetBrowser);

  // Verify extension exists
  try {
    await access(extensionPath);
    const files = await readdir(extensionPath);
    if (!files.includes('manifest.json')) {
      throw new Error(`No manifest.json found in ${extensionPath}. Did you build the extension?`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Extension not found at ${extensionPath}. Run 'npm run build' in packages/extension first.`
      );
    }
    throw err;
  }

  let context: BrowserContext;

  if (targetBrowser === 'firefox') {
    const firefoxWithExt = withExtension(firefox, extensionPath);
    context = await firefoxWithExt.launchPersistentContext(USER_DATA_DIR, {
      headless: false,
      slowMo: options.slowMo,
    });
  } else {
    context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--no-first-run',
        '--disable-default-apps',
      ],
      slowMo: options.slowMo,
      devtools: options.devtools,
    });
  }

  // Get extension ID
  const extensionId = await getExtensionId(context);
  const serviceWorkerUrl = extensionUrl(extensionId, 'background.js');

  return {
    context,
    extensionId,
    serviceWorkerUrl,
  };
}

/**
 * Get the extension ID by waiting for service worker (Chrome) or background page (Firefox)
 */
async function getExtensionId(context: BrowserContext): Promise<string> {
  const page = await context.newPage();

  let extensionId = '';
  let attempts = 0;
  const maxAttempts = 30;

  while (!extensionId && attempts < maxAttempts) {
    // Chrome: service workers
    for (const worker of context.serviceWorkers()) {
      const match = worker.url().match(/chrome-extension:\/\/([a-z]{32})\//);
      if (match) {
        extensionId = match[1];
        break;
      }
    }

    // Firefox: background pages
    if (!extensionId) {
      for (const bg of context.backgroundPages()) {
        const match = bg.url().match(/moz-extension:\/\/([^/]+)\//);
        if (match) {
          extensionId = match[1];
          break;
        }
      }
    }

    if (!extensionId) {
      await page.waitForTimeout(100);
      attempts++;
    }
  }

  await page.close();

  if (!extensionId) {
    throw new Error('Could not find extension ID. Extension may not have loaded properly.');
  }

  return extensionId;
}

/**
 * Navigate to the extension popup
 */
export async function openExtensionPopup(
  context: BrowserContext,
  extensionId: string
): Promise<Page> {
  const popupUrl = extensionUrl(extensionId, 'popup.html');
  const page = await context.newPage();
  await page.goto(popupUrl);
  return page;
}

/**
 * Navigate to the extension's offscreen document (Chrome only)
 */
export async function openOffscreenDocument(
  context: BrowserContext,
  extensionId: string
): Promise<Page> {
  const offscreenUrl = extensionUrl(extensionId, 'offscreen.html');
  const page = await context.newPage();
  await page.goto(offscreenUrl);
  return page;
}

/**
 * Reload the extension by navigating to chrome://extensions and clicking reload.
 * Chrome-only — Firefox temporary add-ons are reloaded via about:debugging.
 */
export async function reloadExtension(
  context: BrowserContext,
  extensionId: string
): Promise<void> {
  const page = await context.newPage();

  try {
    // Go to chrome://extensions
    await page.goto('chrome://extensions');

    // Enable developer mode if not already enabled
    const devModeToggle = page.locator('extensions-manager').locator('cr-toggle#devMode');
    const isDevModeOn = await devModeToggle.getAttribute('checked');
    if (isDevModeOn === null) {
      await devModeToggle.click();
      await page.waitForTimeout(500);
    }

    // Find our extension card and click reload
    await page.evaluate((extId) => {
      const manager = document.querySelector('extensions-manager');
      if (!manager?.shadowRoot) return;

      const itemList = manager.shadowRoot.querySelector('extensions-item-list');
      if (!itemList?.shadowRoot) return;

      const items = itemList.shadowRoot.querySelectorAll('extensions-item');
      for (const item of items) {
        if (!item.shadowRoot) continue;
        const id = item.getAttribute('id');
        if (id === extId) {
          const reloadButton = item.shadowRoot.querySelector('#dev-reload-button');
          if (reloadButton) {
            (reloadButton as HTMLElement).click();
            return;
          }
        }
      }
    }, extensionId);

    // Wait for reload to complete
    await page.waitForTimeout(1000);
  } finally {
    await page.close();
  }
}

/**
 * Wait for the extension to be ready (service worker or background page active)
 */
export async function waitForExtensionReady(
  context: BrowserContext,
  extensionId: string,
  timeoutMs: number = 10000
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    // Check Chrome service workers
    const extensionWorker = context.serviceWorkers().find((w) =>
      w.url().includes(`chrome-extension://${extensionId}`)
    );
    if (extensionWorker) return;

    // Check Firefox background pages
    const extensionBg = context.backgroundPages().find((p) =>
      p.url().includes(`moz-extension://${extensionId}`)
    );
    if (extensionBg) return;

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Extension ${extensionId} not ready after ${timeoutMs}ms`);
}

/**
 * Get all console messages from a page
 */
export function captureConsoleLogs(page: Page): Array<{ type: string; text: string; time: Date }> {
  const logs: Array<{ type: string; text: string; time: Date }> = [];

  page.on('console', (msg) => {
    logs.push({
      type: msg.type(),
      text: msg.text(),
      time: new Date(),
    });
  });

  return logs;
}

/**
 * Clean up browser context and user data
 */
export async function cleanupBrowserContext(context: BrowserContext): Promise<void> {
  await context.close();
}
