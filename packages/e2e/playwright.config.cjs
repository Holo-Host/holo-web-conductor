// @ts-check
const { defineConfig, devices } = require('@playwright/test');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const EXTENSION_PATH = path.join(PROJECT_ROOT, 'packages', 'extension', 'dist');
const ZIPTEST_UI_PATH = path.resolve(PROJECT_ROOT, '..', 'ziptest', 'ui', 'dist');

/**
 * Playwright configuration for Fishy E2E tests
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
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            `--disable-extensions-except=${EXTENSION_PATH}`,
            `--load-extension=${EXTENSION_PATH}`,
            '--no-first-run',
            '--disable-default-apps',
          ],
        },
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
  ],
});
