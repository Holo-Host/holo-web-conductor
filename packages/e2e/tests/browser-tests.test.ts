/**
 * Browser-Only E2E Tests
 *
 * Tests the extension's local WASM execution against the happ-test.html
 * test page. Runs on both Chrome and Firefox without requiring external
 * conductors, linker, or hApp repos.
 *
 * Exercises: hApp install, connect, get_agent_info, CRUD entries, links,
 * signals, query, signing, and transaction rollback.
 *
 * Prerequisites:
 *   npm run build          (builds extension to dist-chrome/ and dist-firefox/)
 *   Test page served at http://localhost:3333/happ-test.html
 */

import { test, expect } from '@playwright/test';
import {
  createAgentContext,
  cleanupAgentContext,
  waitForExtensionReady,
  type AgentContext,
} from './fixtures';

const TEST_PAGE_URL = 'http://localhost:3333/happ-test.html';

/**
 * Run the happ-test.html "Run All Tests" suite in a browser agent and
 * return { passed, total, failures }.
 */
async function runAllTestsInAgent(agent: AgentContext): Promise<{
  passed: number;
  total: number;
  failures: string[];
  consoleErrors: string[];
}> {
  const consoleErrors: string[] = [];
  const consoleHandler = (msg: any) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  };
  agent.page.on('console', consoleHandler);

  // Navigate to test page
  console.log(`[${agent.name}] Navigating to ${TEST_PAGE_URL}...`);
  await agent.page.goto(TEST_PAGE_URL, { waitUntil: 'domcontentloaded' });

  // Wait for extension to inject window.holochain
  console.log(`[${agent.name}] Waiting for extension...`);
  await waitForExtensionReady(agent.page, 15000);
  console.log(`[${agent.name}] Extension ready`);

  // Click "Run All Tests" button
  console.log(`[${agent.name}] Clicking "Run All Tests"...`);
  const runAllBtn = agent.page.locator('#run-all-btn');
  await runAllBtn.waitFor({ state: 'visible', timeout: 5000 });
  await runAllBtn.click();

  // Wait for the button to be re-enabled (tests complete) or the summary to appear
  // The test suite installs a hApp, connects, and runs ~20 zome calls; allow up to 2 min
  console.log(`[${agent.name}] Waiting for tests to complete...`);
  await agent.page.waitForFunction(
    () => {
      const btn = document.getElementById('run-all-btn') as HTMLButtonElement;
      return btn && !btn.disabled;
    },
    { timeout: 120000 },
  );

  // Extract results from the summary element
  const results = await agent.page.evaluate(() => {
    const summaryEl = document.getElementById('summary');
    const summaryText = summaryEl?.textContent || '';

    // Parse "X/Y passed" from the summary
    const match = summaryText.match(/(\d+)\/(\d+)\s+passed/);
    const passed = match ? parseInt(match[1], 10) : 0;
    const total = match ? parseInt(match[2], 10) : 0;

    // Collect failure details from the summary list items
    const failures: string[] = [];
    const failItems = summaryEl?.querySelectorAll('li');
    if (failItems) {
      failItems.forEach((li) => failures.push(li.textContent || ''));
    }

    return { passed, total, failures };
  });

  agent.page.off('console', consoleHandler);
  return { ...results, consoleErrors };
}

test.describe('browser-only extension tests (happ-test.html)', () => {
  let chrome: AgentContext;
  let firefox: AgentContext;

  test.beforeAll(async () => {
    // Launch both browsers with their respective extensions
    chrome = await createAgentContext('browser-test-chrome', 'chrome');
    firefox = await createAgentContext('browser-test-firefox', 'firefox');
  });

  test.afterAll(async () => {
    if (chrome) await cleanupAgentContext(chrome);
    if (firefox) await cleanupAgentContext(firefox);
  });

  test('chrome: all happ-test.html tests pass', async () => {
    test.setTimeout(180000); // 3 min

    const results = await runAllTestsInAgent(chrome);

    console.log(`[chrome] Results: ${results.passed}/${results.total} passed`);
    if (results.failures.length > 0) {
      console.log(`[chrome] Failures:`);
      results.failures.forEach((f) => console.log(`  - ${f}`));
    }
    if (results.consoleErrors.length > 0) {
      console.log(`[chrome] Console errors:`);
      results.consoleErrors.forEach((e) => console.log(`  - ${e}`));
    }

    expect(results.total).toBeGreaterThan(0);
    expect(results.passed).toBe(results.total);
    expect(results.failures).toHaveLength(0);
  });

  test('firefox: all happ-test.html tests pass', async () => {
    test.setTimeout(180000); // 3 min

    const results = await runAllTestsInAgent(firefox);

    console.log(`[firefox] Results: ${results.passed}/${results.total} passed`);
    if (results.failures.length > 0) {
      console.log(`[firefox] Failures:`);
      results.failures.forEach((f) => console.log(`  - ${f}`));
    }
    if (results.consoleErrors.length > 0) {
      console.log(`[firefox] Console errors:`);
      results.consoleErrors.forEach((e) => console.log(`  - ${e}`));
    }

    expect(results.total).toBeGreaterThan(0);
    expect(results.passed).toBe(results.total);
    expect(results.failures).toHaveLength(0);
  });
});
