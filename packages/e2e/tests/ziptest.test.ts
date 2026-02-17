/**
 * Ziptest Multi-Agent E2E Test
 *
 * Tests multi-agent interactions including:
 * - Profile creation and discovery
 * - Agent active status via pings
 * - Signal sending/receiving
 * - Entry creation and synchronization
 *
 * Prerequisites:
 * 1. Run: ./scripts/e2e-test-setup.sh start --happ=ziptest
 * 2. Ziptest UI must be served at http://localhost:8081
 * 3. Extension must be built: npm run build:extension
 */

import { test, expect } from '@playwright/test';
import {
  createAgentContext,
  cleanupAgentContext,
  createProfile,
  waitForAgentVisible,
  waitForAgentActive,
  navigateToEntries,
  navigateToSignals,
  selectAgent,
  createEntryTest,
  selectTest,
  startTest,
  watchTest,
  waitForTestCompletion,
  startSignalTest,
  ZIPTEST_UI_URL,
  type AgentContext,
} from './fixtures.js';

// Timeouts for various operations
const TIMEOUTS = {
  extensionInit: 15000,
  profileCreation: 60000,
  profileVisibility: 90000,
  agentActive: 120000,
  testCompletion: 180000,
};

// Single comprehensive test - avoids Playwright lifecycle issues with shared contexts
test('ziptest multi-agent e2e', async () => {
  test.setTimeout(300000); // 5 minutes

  let zippy: AgentContext | undefined;
  let zerbina: AgentContext | undefined;

  try {
    // Setup: Create two browser contexts
    console.log('Creating agent contexts...');
    zippy = await createAgentContext('zippy');
    zerbina = await createAgentContext('zerbina');
    console.log('Agent contexts created');

    // Navigate both agents to ziptest UI
    console.log('Navigating to ziptest UI...');
    await Promise.all([
      zippy.page.goto(ZIPTEST_UI_URL),
      zerbina.page.goto(ZIPTEST_UI_URL),
    ]);

    // Wait for Holochain extension to be ready on both pages
    console.log('Waiting for Holochain extension...');
    await Promise.all([
      zippy.page.waitForFunction(() => (window as any).holochain?.isWebConductor === true, {
        timeout: TIMEOUTS.extensionInit,
      }),
      zerbina.page.waitForFunction(() => (window as any).holochain?.isWebConductor === true, {
        timeout: TIMEOUTS.extensionInit,
      }),
    ]);

    // Create profiles for both agents
    console.log('Creating profiles...');
    await Promise.all([
      createProfile(zippy.page, 'zippy'),
      createProfile(zerbina.page, 'zerbina'),
    ]);

    console.log('Profiles created, waiting for mutual visibility...');

    // Wait for agents to see each other and become active
    await Promise.all([
      waitForAgentVisible(zippy.page, 'zerbina', TIMEOUTS.profileVisibility),
      waitForAgentVisible(zerbina.page, 'zippy', TIMEOUTS.profileVisibility),
    ]);

    console.log('Agents are mutually visible');

    // Signal test
    console.log('Starting signal test...');

    // Zippy: Navigate to Signals, select zerbina, send 10 signals
    await navigateToSignals(zippy.page);
    await selectAgent(zippy.page, 'zerbina');
    await startSignalTest(zippy.page, { count: 10, delay: 200 });

    // Wait for signals to be sent
    await expect(zippy.page.locator('text=/10 of 10 sent/')).toBeVisible({
      timeout: 15000,
    });
    console.log('Zippy sent 10 signals');

    // Zerbina: Navigate to Signals, select zippy, verify 10 received
    await navigateToSignals(zerbina.page);
    await selectAgent(zerbina.page, 'zippy');

    // Wait for signals to be received
    await expect(zerbina.page.locator('text=/10 of 10 received/')).toBeVisible({
      timeout: 15000,
    });
    console.log('Zerbina received 10 signals');
    console.log('Signal test completed');

    // Entry test
    console.log('Starting entry test...');

    // Zippy: Navigate to Entries, set count to 10, create test
    await navigateToEntries(zippy.page);
    await createEntryTest(zippy.page, { count: 10 });
    console.log('Zippy created entry test');

    // Zerbina: Navigate to Entries, wait for test to appear, select zippy's test
    await navigateToEntries(zerbina.page);
    await zerbina.page.waitForSelector('.bunch-item', { timeout: 60000 });
    await selectTest(zerbina.page, 'zippy');
    await watchTest(zerbina.page);
    console.log('Zerbina watching test');

    // Zippy: Select the same test and start it
    await selectTest(zippy.page, 'zippy');
    await startTest(zippy.page);
    console.log('Zippy started test');

    // Wait for both to see completion
    await Promise.all([
      waitForTestCompletion(zippy.page, TIMEOUTS.testCompletion),
      waitForTestCompletion(zerbina.page, TIMEOUTS.testCompletion),
    ]);

    console.log('All tests completed successfully');

  } finally {
    // Cleanup
    console.log('Cleaning up...');
    if (zippy) await cleanupAgentContext(zippy);
    if (zerbina) await cleanupAgentContext(zerbina);
    console.log('Cleanup complete');
  }
});

