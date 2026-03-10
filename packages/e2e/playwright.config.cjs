// @ts-check
const { defineConfig, devices } = require('@playwright/test');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const CHROME_EXTENSION_PATH = path.join(PROJECT_ROOT, 'packages', 'extension', 'dist-chrome');
const ZIPTEST_UI_PATH = path.resolve(PROJECT_ROOT, '..', 'ziptest', 'ui', 'dist');
const MEWSFEED_UI_PATH = path.resolve(PROJECT_ROOT, '..', 'mewsfeed', 'ui', 'dist');

/**
 * Playwright configuration for HWC E2E tests
 *
 * Run Chrome tests:  BROWSER=chrome npx playwright test --project=chromium-extension
 * Run Firefox tests: BROWSER=firefox npx playwright test --project=firefox-extension
 */
module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [
    ['list'],
    ['json', { outputFile: 'test-results/results.json' }],
  ],
  // Longer timeout for multi-agent sync tests
  timeout: 180000,

  use: {
    headless: false,
    trace: 'on-first-retry',
    video: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium-extension',
      testIgnore: /cross-browser/,
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
    {
      name: 'firefox-extension',
      testIgnore: /cross-browser/,
      use: {
        ...devices['Desktop Firefox'],
      },
    },
    {
      // Cross-browser tests manage their own browser contexts internally
      name: 'cross-browser',
      testMatch: /cross-browser/,
      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],

  outputDir: 'test-results/',

  // Serve test pages via HTTP to avoid file:// URL issues with Chrome extension
  webServer: [
    {
      command: `npx http-server ${path.join(PROJECT_ROOT, 'packages', 'extension', 'test')} -p 3333 --cors -c-1`,
      url: 'http://localhost:3333',
      reuseExistingServer: !process.env.CI,
    },
    {
      // Ziptest UI server for multi-agent tests
      command: `npx http-server "${ZIPTEST_UI_PATH}" -p 8081 --cors -c-1`,
      url: 'http://localhost:8081',
      reuseExistingServer: !process.env.CI,
    },
    {
      // Mewsfeed UI server for mewsfeed and cross-browser tests
      command: `npx http-server "${MEWSFEED_UI_PATH}" -p 8082 --cors -c-1`,
      url: 'http://localhost:8082',
      reuseExistingServer: !process.env.CI,
    },
  ],
});
