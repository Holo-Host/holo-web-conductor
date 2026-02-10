/**
 * Mewsfeed Multi-Agent E2E Test
 *
 * Tests the fishy extension + hc-membrane kitsune mode with the mewsfeed DNA,
 * which is much more complex than ziptest (5 integrity + 6 coordinator zomes).
 *
 * Flow:
 * 1. Two agents (alice, bob) open the mewsfeed UI
 * 2. Both create profiles
 * 3. Alice creates a mew with a hashtag
 * 4. Bob searches for that hashtag and finds Alice's mew
 */

import { test, expect } from '@playwright/test';
import {
  createAgentContext,
  cleanupAgentContext,
  waitForExtensionReady,
  createMewsfeedProfile,
  createMew,
  waitForHashtagResult,
  MEWSFEED_UI_URL,
  type AgentContext,
} from './fixtures';

test.describe('mewsfeed multi-agent hashtag e2e', () => {
  let alice: AgentContext;
  let bob: AgentContext;

  test.beforeAll(async () => {
    // Create two isolated browser contexts with the extension loaded
    alice = await createAgentContext('alice');
    bob = await createAgentContext('bob');
  });

  test.afterAll(async () => {
    if (alice) await cleanupAgentContext(alice);
    if (bob) await cleanupAgentContext(bob);
  });

  test('alice creates mew with hashtag, bob finds it via search', async () => {
    test.setTimeout(300000); // 5 minutes

    const TEST_HASHTAG = 'testmew';
    const MEW_TEXT = `Testing fishy extension with mewsfeed #${TEST_HASHTAG}`;

    // --- Navigate both agents to mewsfeed UI ---
    console.log('[test] Navigating alice to mewsfeed UI...');
    await alice.page.goto(MEWSFEED_UI_URL);
    console.log('[test] Navigating bob to mewsfeed UI...');
    await bob.page.goto(MEWSFEED_UI_URL);

    // --- Wait for fishy extension to be ready on both pages ---
    console.log('[test] Waiting for extension ready on alice...');
    await waitForExtensionReady(alice.page, 30000);
    console.log('[test] Waiting for extension ready on bob...');
    await waitForExtensionReady(bob.page, 30000);

    // --- Both agents create profiles ---
    console.log('[test] Creating profile for alice...');
    await createMewsfeedProfile(alice.page, 'alice');
    console.log('[test] Creating profile for bob...');
    await createMewsfeedProfile(bob.page, 'bobcat');

    // --- Alice creates a mew with a hashtag ---
    console.log('[test] Alice creating mew with hashtag...');
    await createMew(alice.page, MEW_TEXT);

    // --- Wait for DHT propagation ---
    console.log('[test] Waiting 20s for DHT propagation...');
    await bob.page.waitForTimeout(20000);

    // --- Bob navigates to hashtag page and looks for the mew ---
    console.log(`[test] Bob searching for #${TEST_HASHTAG}...`);
    await waitForHashtagResult(bob.page, TEST_HASHTAG, 120000);

    // --- Verify Bob can see Alice's mew content ---
    const mewContent = await bob.page.textContent('body');
    expect(mewContent).toContain('fishy extension');
    console.log('[test] Bob found Alice\'s mew via hashtag search');
  });
});
