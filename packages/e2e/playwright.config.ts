import { defineConfig, devices } from '@playwright/test';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');
const EXTENSION_PATH = join(PROJECT_ROOT, 'packages', 'extension', 'dist');

/**
 * Playwright configuration for Fishy E2E tests
 *
 * Note: Extensions require a persistent context with headed mode.
 * Tests use a custom fixture that loads the extension.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false, // Extensions don't work well with parallel contexts
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1, // Single worker for extension tests
  reporter: [
    ['list'],
    ['json', { outputFile: 'test-results/results.json' }],
  ],
  timeout: 60000, // 60 second timeout for e2e tests

  use: {
    // Extension tests require headed mode
    headless: false,
    trace: 'on-first-retry',
    video: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium-extension',
      use: {
        ...devices['Desktop Chrome'],
        // Custom launch options for extension loading
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

  // Output directory for test artifacts
  outputDir: 'test-results/',

  // Global setup/teardown
  globalSetup: undefined, // Environment is managed by TestRunner
  globalTeardown: undefined,

  // Serve test page via HTTP to avoid file:// URL issues with Chrome extension
  webServer: {
    command: `npx http-server ${join(PROJECT_ROOT, 'packages', 'extension', 'test')} -p 3333 --cors -c-1`,
    url: 'http://localhost:3333',
    reuseExistingServer: !process.env.CI,
  },
});
