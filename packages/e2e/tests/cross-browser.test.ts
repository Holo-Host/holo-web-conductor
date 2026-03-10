/**
 * Cross-Browser Mewsfeed E2E Test
 *
 * Tests interoperability between Chrome and Firefox HWC extensions.
 * Alice runs on Chrome, Bob runs on Firefox. They interact via the
 * mewsfeed hApp through the same linker.
 *
 * Flow:
 * 1. Alice (Chrome) and Bob (Firefox) open the mewsfeed UI
 * 2. Both create profiles
 * 3. Alice creates a mew with a hashtag
 * 4. Bob searches for that hashtag and finds Alice's mew
 *
 * Prerequisites:
 * 1. Run: ./scripts/e2e-test-setup.sh start --happ=mewsfeed
 * 2. Both extensions built: npm run build (in packages/extension)
 * 3. Mewsfeed UI served at http://localhost:8082
 */

import { test, expect } from '@playwright/test';
import {
  createAgentContext,
  cleanupAgentContext,
  waitForExtensionReady,
  setupAutoRetry,
  createMewsfeedProfile,
  createMew,
  waitForHashtagResult,
  callZome,
  MEWSFEED_UI_URL,
  type AgentContext,
} from './fixtures';

test.describe('cross-browser mewsfeed e2e (Chrome + Firefox)', () => {
  let alice: AgentContext;
  let bob: AgentContext;

  test.beforeAll(async () => {
    // Alice on Chrome, Bob on Firefox
    alice = await createAgentContext('alice-chrome', 'chrome');
    bob = await createAgentContext('bob-firefox', 'firefox');
  });

  test.afterAll(async () => {
    if (alice) await cleanupAgentContext(alice);
    if (bob) await cleanupAgentContext(bob);
  });

  test('alice (chrome) creates mew, bob (firefox) finds it via hashtag', async () => {
    test.setTimeout(300000); // 5 minutes

    const TEST_HASHTAG = 'crossbrowser';
    const MEW_TEXT = `Cross-browser test from Chrome to Firefox #${TEST_HASHTAG}`;

    // --- Navigate both agents to mewsfeed UI ---
    console.log('[test] Navigating alice (chrome) to mewsfeed UI...');
    await alice.page.goto(MEWSFEED_UI_URL);
    console.log('[test] Navigating bob (firefox) to mewsfeed UI...');
    await bob.page.goto(MEWSFEED_UI_URL);

    // --- Wait for hwc extension to be ready on both pages ---
    console.log('[test] Waiting for extension ready on alice (chrome)...');
    await waitForExtensionReady(alice.page, 60000);
    console.log('[test] Waiting for extension ready on bob (firefox)...');
    await waitForExtensionReady(bob.page, 60000);

    // Auto-click Retry buttons from the connectWithJoiningUI overlay.
    // On Firefox, the event page may be suspended, causing holochain.connect()
    // to fail on the first attempt. The overlay shows a Retry button.
    await setupAutoRetry(alice.page, 'alice-chrome');
    await setupAutoRetry(bob.page, 'bob-firefox');

    // Give the app time to install hApp, initialize WASM, and render.
    // Firefox may need extra time due to event page restart + retry cycle.
    console.log('[test] Waiting for app initialization...');
    await alice.page.waitForTimeout(20000);

    // --- Navigate to /feed ---
    console.log('[test] Navigating both agents to /feed...');
    for (const agent of [alice, bob]) {
      await agent.page.evaluate(() => {
        history.pushState({}, '', '/feed');
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
      await agent.page.waitForTimeout(3000);
    }

    // Wait for mew input to appear (longer timeout for Firefox retry cycle)
    const mewInputSelector = '[data-placeholder="What\'s mewing on?"]';
    console.log('[test] Waiting for CreateMewInput on both agents...');
    await alice.page.locator(mewInputSelector).first()
      .waitFor({ state: 'visible', timeout: 60000 });
    await bob.page.locator(mewInputSelector).first()
      .waitFor({ state: 'visible', timeout: 60000 });

    // --- Both agents create profiles ---
    console.log('[test] Creating profile for alice (chrome)...');
    await createMewsfeedProfile(alice.page, 'alice-chrome');
    console.log('[test] Creating profile for bob (firefox)...');
    await createMewsfeedProfile(bob.page, 'bob-firefox');

    // Navigate back to /feed after profile creation
    console.log('[test] Re-navigating alice to /feed...');
    await alice.page.evaluate(() => {
      history.pushState({}, '', '/feed');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await alice.page.waitForTimeout(3000);

    // --- Alice creates a mew with a hashtag ---
    console.log('[test] Alice (chrome) creating mew with hashtag...');
    await createMew(alice.page, MEW_TEXT);

    // Verify alice can see her own mew
    console.log('[test] Verifying alice can see her mew on feed...');
    await alice.page.evaluate(() => {
      history.pushState({}, '', '/feed');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await alice.page.waitForTimeout(5000);
    const aliceFeedText = (await alice.page.textContent('body')) || '';
    console.log(`[test] Alice can see own mew: ${aliceFeedText.includes('Cross-browser')}`);

    // --- Wait for DHT propagation ---
    console.log('[test] Waiting 30s for DHT propagation...');
    await bob.page.waitForTimeout(30000);

    // --- Bob searches for the hashtag ---
    console.log(`[test] Bob (firefox) searching for #${TEST_HASHTAG} via UI...`);
    await waitForHashtagResult(bob.page, TEST_HASHTAG, 'Cross-browser', 120000);
    console.log('[test] Bob (firefox) found Alice (chrome) mew via hashtag search');
  });
});
