// @ts-check
/**
 * Playwright config for browser-only tests (happ-test.html).
 *
 * Unlike the full e2e config, this does NOT require ziptest/mewsfeed repos,
 * conductors, linker, or bootstrap server. It only needs the extension built.
 */
const { defineConfig, devices } = require('@playwright/test');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const CHROME_EXTENSION_PATH = path.join(PROJECT_ROOT, 'packages', 'extension', 'dist-chrome');

module.exports = defineConfig({
  testDir: './tests',
  testMatch: /browser-tests/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list']],
  timeout: 180000, // 3 min per test (hApp install + 20 zome calls)

  use: {
    headless: false,
    trace: 'on-first-retry',
  },

  projects: [
    {
      // The test manages its own Chrome + Firefox contexts internally
      // (like cross-browser.test.ts), so we only need one project entry.
      name: 'browser-tests',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            `--disable-extensions-except=${CHROME_EXTENSION_PATH}`,
            `--load-extension=${CHROME_EXTENSION_PATH}`,
            '--no-first-run',
            '--disable-default-apps',
          ],
        },
      },
    },
  ],

  outputDir: 'test-results/',

  // Only serve the extension test pages (no ziptest/mewsfeed UI needed)
  webServer: {
    command: `npx http-server ${path.join(PROJECT_ROOT, 'packages', 'extension', 'test')} -p 3333 --cors -c-1`,
    url: 'http://localhost:3333',
    reuseExistingServer: true,
  },
});
