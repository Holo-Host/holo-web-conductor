/**
 * Chain Recovery E2E Test
 *
 * Tests the full chain recovery flow:
 * 1. Two agents create data (entries via ziptest)
 * 2. Alice exports her agent key
 * 3. Alice's hApp is uninstalled (key + context deleted)
 * 4. Alice imports her key back
 * 5. Alice re-visits the app (triggers reinstall with existing key)
 * 6. Alice triggers chain recovery from DHT
 * 7. Verify recovered data is accessible
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
  navigateToEntries,
  createEntryTest,
  selectTest,
  startTest,
  watchTest,
  waitForTestCompletion,
  exportAgentKey,
  importAgentKey,
  uninstallHappViaPopup,
  triggerChainRecovery,
  ZIPTEST_UI_URL,
  type AgentContext,
} from './fixtures.js';

const AGENT_KEY_TAG = 'http://localhost:8081:agent';
const EXPORT_PASSPHRASE = 'test-recovery-passphrase-12345';

const TIMEOUTS = {
  extensionInit: 15000,
  profileCreation: 60000,
  profileVisibility: 90000,
  testCompletion: 180000,
  recovery: 120000,
};

test('chain recovery after key export, uninstall, and reimport', async () => {
  test.setTimeout(600000); // 10 minutes - recovery flow is long

  let alice: AgentContext | undefined;
  let bob: AgentContext | undefined;

  try {
    // ========================================================================
    // Phase 1: Setup two agents
    // ========================================================================
    console.log('=== Phase 1: Setup two agents ===');

    alice = await createAgentContext('alice');
    bob = await createAgentContext('bob');

    // Navigate both to ziptest UI
    await Promise.all([
      alice.page.goto(ZIPTEST_UI_URL),
      bob.page.goto(ZIPTEST_UI_URL),
    ]);

    // Wait for extension readiness
    await Promise.all([
      alice.page.waitForFunction(() => (window as any).holochain?.isWebConductor === true, {
        timeout: TIMEOUTS.extensionInit,
      }),
      bob.page.waitForFunction(() => (window as any).holochain?.isWebConductor === true, {
        timeout: TIMEOUTS.extensionInit,
      }),
    ]);

    // Create profiles
    console.log('Creating profiles...');
    await Promise.all([
      createProfile(alice.page, 'alice'),
      createProfile(bob.page, 'bob'),
    ]);

    // Wait for mutual visibility
    console.log('Waiting for mutual visibility...');
    await Promise.all([
      waitForAgentVisible(alice.page, 'bob', TIMEOUTS.profileVisibility),
      waitForAgentVisible(bob.page, 'alice', TIMEOUTS.profileVisibility),
    ]);
    console.log('Agents are mutually visible');

    // ========================================================================
    // Phase 2: Create test data on Alice's chain
    // ========================================================================
    console.log('=== Phase 2: Create test data ===');

    await navigateToEntries(alice.page);
    await createEntryTest(alice.page, { count: 5 });
    console.log('Alice created entry test');

    await navigateToEntries(bob.page);
    await bob.page.waitForSelector('.bunch-item', { timeout: 60000 });
    await selectTest(bob.page, 'alice');
    await watchTest(bob.page);
    console.log('Bob watching test');

    await selectTest(alice.page, 'alice');
    await startTest(alice.page);
    console.log('Alice started test');

    await Promise.all([
      waitForTestCompletion(alice.page, TIMEOUTS.testCompletion),
      waitForTestCompletion(bob.page, TIMEOUTS.testCompletion),
    ]);
    console.log('Entry test completed - data exists on chain and DHT');

    // ========================================================================
    // Phase 3: Export Alice's agent key
    // ========================================================================
    console.log('=== Phase 3: Export Alice agent key ===');

    const encryptedKeyJson = await exportAgentKey(alice, AGENT_KEY_TAG, EXPORT_PASSPHRASE);
    console.log('Alice key exported successfully');

    // ========================================================================
    // Phase 4: Uninstall Alice's hApp (destroys key + context)
    // ========================================================================
    console.log('=== Phase 4: Uninstall Alice hApp ===');

    await uninstallHappViaPopup(alice);
    console.log('Alice hApp uninstalled');

    // ========================================================================
    // Phase 5: Import Alice's key back
    // ========================================================================
    console.log('=== Phase 5: Import Alice key ===');

    await importAgentKey(alice, encryptedKeyJson, EXPORT_PASSPHRASE, AGENT_KEY_TAG);
    console.log('Alice key imported');

    // ========================================================================
    // Phase 6: Re-visit app and trigger chain recovery
    // ========================================================================
    console.log('=== Phase 6: Chain recovery ===');

    // Navigate Alice back to the ziptest UI - this triggers reinstall with existing key
    await alice.page.goto(ZIPTEST_UI_URL);
    await alice.page.waitForFunction(
      () => (window as any).holochain?.isWebConductor === true,
      { timeout: TIMEOUTS.extensionInit }
    );

    // Wait for profile creation screen or controller (hApp is now reinstalled)
    // Since chain is empty after reinstall, we may see the create-profile screen
    await alice.page.waitForSelector('create-profile, .test-type', { timeout: 60000 });
    console.log('Alice hApp reinstalled with recovered key');

    // Trigger chain recovery via popup
    const result = await triggerChainRecovery(alice, TIMEOUTS.recovery);
    console.log(`Recovery result: ${result.recovered} recovered, ${result.failed} failed`);

    expect(result.recovered).toBeGreaterThan(0);

    // ========================================================================
    // Phase 7: Verify recovered data
    // ========================================================================
    console.log('=== Phase 7: Verify recovered data ===');

    // Reload the page to pick up recovered chain data
    await alice.page.goto(ZIPTEST_UI_URL);
    await alice.page.waitForFunction(
      () => (window as any).holochain?.isWebConductor === true,
      { timeout: TIMEOUTS.extensionInit }
    );

    // After recovery, the profile should exist again (recovered from chain)
    // so we should see the controller, not the create-profile screen
    await alice.page.waitForSelector('.test-type', { timeout: 60000 });
    console.log('Alice profile recovered - controller visible');

    // Navigate to entries and verify previous test data is visible
    await navigateToEntries(alice.page);

    // Wait for the previous entry test to appear in the list
    await alice.page.waitForSelector('.bunch-item', { timeout: 60000 });
    console.log('Recovered entries are visible');

    console.log('=== Chain recovery e2e test PASSED ===');

  } finally {
    console.log('Cleaning up...');
    if (alice) await cleanupAgentContext(alice);
    if (bob) await cleanupAgentContext(bob);
    console.log('Cleanup complete');
  }
});
