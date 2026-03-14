/**
 * Mewsfeed Multi-Agent E2E Test
 *
 * Tests the hwc extension + h2hc-linker kitsune mode with the mewsfeed DNA.
 * Verifies the full pipeline: mew created in one browser appears rendered
 * in another browser's UI after DHT propagation.
 *
 * Flow:
 * 1. Two agents (alice, bob) open the mewsfeed UI
 * 2. Both create profiles (triggered by attempting to send a mew)
 * 3. Alice creates a mew with a hashtag via the UI
 * 4. Bob navigates to the hashtag page and polls (via page reload) until
 *    Alice's mew text appears rendered in the UI
 */

import { test, expect } from '@playwright/test';
import {
  createAgentContext,
  cleanupAgentContext,
  waitForExtensionReady,
  createMewsfeedProfile,
  createMew,
  MEWSFEED_UI_URL,
  type AgentContext,
} from './fixtures';

test.describe('mewsfeed multi-agent e2e', () => {
  let alice: AgentContext;
  let bob: AgentContext;

  test.beforeAll(async () => {
    alice = await createAgentContext('alice');
    bob = await createAgentContext('bob');
  });

  test.afterAll(async () => {
    if (alice) await cleanupAgentContext(alice);
    if (bob) await cleanupAgentContext(bob);
  });

  test('alice creates mew, bob sees it rendered in UI', async () => {
    test.setTimeout(300000); // 5 minutes

    // --- Navigate both agents to mewsfeed UI ---
    console.log('[test] Navigating agents to mewsfeed UI...');
    await alice.page.goto(MEWSFEED_UI_URL);
    await bob.page.goto(MEWSFEED_UI_URL);

    // --- Wait for hwc extension to be ready ---
    console.log('[test] Waiting for extension ready...');
    await waitForExtensionReady(alice.page, 60000);
    await waitForExtensionReady(bob.page, 60000);

    // Wait for app to install hApp and initialize WASM
    console.log('[test] Waiting for hApp initialization...');
    await alice.page.waitForTimeout(10000);

    // --- Navigate to /feed ---
    console.log('[test] Navigating to /feed...');
    for (const agent of [alice, bob]) {
      await agent.page.evaluate(() => {
        history.pushState({}, '', '/feed');
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
    }
    await alice.page.waitForTimeout(2000);

    // Wait for the CreateMewInput to confirm the feed page rendered
    const mewInputSelector = '[data-placeholder="What\'s mewing on?"]';
    console.log('[test] Waiting for CreateMewInput...');
    await alice.page.locator(mewInputSelector).first()
      .waitFor({ state: 'visible', timeout: 30000 });
    await bob.page.locator(mewInputSelector).first()
      .waitFor({ state: 'visible', timeout: 30000 });
    console.log('[test] Both agents see feed UI');

    // --- Create profiles via UI ---
    // createMewsfeedProfile clicks "Send Mew" to trigger the profile dialog,
    // fills in the nickname, and saves — simulating what a real user does.
    console.log('[test] Creating profiles...');
    await createMewsfeedProfile(alice.page, 'alice');
    await createMewsfeedProfile(bob.page, 'bobcat');
    console.log('[test] Profiles created');

    // Re-navigate to /feed after profile creation
    for (const agent of [alice, bob]) {
      await agent.page.evaluate(() => {
        history.pushState({}, '', '/feed');
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
    }
    await alice.page.waitForTimeout(2000);

    // --- Alice creates a mew with a hashtag via the UI ---
    const HASHTAG = 'hwctest';
    const MEW_TEXT = `Testing multi-agent propagation #${HASHTAG}`;
    console.log('[test] Alice creating mew via UI...');
    await createMew(alice.page, MEW_TEXT);
    console.log('[test] Alice mew created');

    // Screenshot after mew creation
    await alice.page.screenshot({
      path: '/tmp/mewsfeed-alice-after-mew.png',
      fullPage: true,
    });

    // --- Bob navigates to the hashtag page ---
    const hashtagPath = `/hashtag/${HASHTAG}`;
    console.log(`[test] Bob navigating to ${hashtagPath}...`);
    await bob.page.evaluate((path) => {
      history.pushState({}, '', path);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, hashtagPath);
    await bob.page.waitForTimeout(3000);

    // --- Poll Bob's page until Alice's mew text appears in the rendered UI ---
    // Each reload triggers refetchOnMount, which does a single network zome call.
    // This avoids the old navigation-cycling pattern that caused 508 get_links.
    const POLL_INTERVAL = 10000; // 10s between reloads
    const POLL_TIMEOUT = 180000; // 3 minutes
    const startTime = Date.now();
    const mewFragment = 'multi-agent propagation';

    console.log(`[test] Polling Bob's UI for Alice's mew (up to ${POLL_TIMEOUT / 1000}s)...`);

    while (Date.now() - startTime < POLL_TIMEOUT) {
      const bodyText = (await bob.page.textContent('body')) || '';
      const elapsed = Math.round((Date.now() - startTime) / 1000);

      if (bodyText.includes(mewFragment)) {
        console.log(`[test] Bob sees Alice's mew rendered in UI after ${elapsed}s`);

        // Take final screenshots showing the mew visible in both browsers
        await alice.page.screenshot({
          path: '/tmp/mewsfeed-alice-final.png',
          fullPage: true,
        });
        await bob.page.screenshot({
          path: '/tmp/mewsfeed-bob-final.png',
          fullPage: true,
        });
        return; // test passes
      }

      const isEmpty = bodyText.includes('nothing here') || bodyText.includes('Nothing');
      console.log(`[test] ${elapsed}s: Bob page empty=${isEmpty}, mew not visible yet`);

      await bob.page.waitForTimeout(POLL_INTERVAL);

      // Reload the hashtag page to trigger a fresh refetchOnMount query
      await bob.page.evaluate((path) => {
        history.pushState({}, '', '/feed');
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
      await bob.page.waitForTimeout(1000);
      await bob.page.evaluate((path) => {
        history.pushState({}, '', path);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }, hashtagPath);
      await bob.page.waitForTimeout(3000);
    }

    // Test failed — take screenshots for debugging
    await alice.page.screenshot({
      path: '/tmp/mewsfeed-alice-final.png',
      fullPage: true,
    });
    await bob.page.screenshot({
      path: '/tmp/mewsfeed-bob-final.png',
      fullPage: true,
    });

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    throw new Error(
      `Timeout after ${elapsed}s: Bob never saw Alice's mew "${mewFragment}" ` +
      `on #${HASHTAG}. Check screenshots at /tmp/mewsfeed-bob-final.png`
    );
  });
});
