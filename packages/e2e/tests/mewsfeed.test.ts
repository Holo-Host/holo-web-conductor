/**
 * Mewsfeed Multi-Agent E2E Test
 *
 * Tests the fishy extension + h2hc-linker kitsune mode with the mewsfeed DNA,
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
  callZome,
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

    // Capture page errors from both agents
    const alicePageErrors: string[] = [];
    const aliceErrors: string[] = [];
    const extensionLogs: string[] = [];
    alice.page.on('pageerror', error => {
      const msg = `${error.name}: ${error.message}\n${error.stack}`;
      alicePageErrors.push(msg);
      console.log('[test] ALICE PAGE ERROR:', msg);
    });
    alice.page.on('console', msg => {
      if (msg.type() === 'error') aliceErrors.push(msg.text());
    });

    // Capture console logs from ALL pages in Alice's context (including offscreen document)
    // The offscreen document is where WASM host functions run and log
    const captureExtensionLogs = () => {
      for (const p of alice.context.pages()) {
        const url = p.url();
        if (url.includes('chrome-extension://') && !url.includes('mewsfeed')) {
          p.on('console', msg => {
            const text = msg.text();
            // Filter for relevant host function and worker logs
            if (text.includes('[create_link]') || text.includes('[get_links]') ||
                text.includes('[create]') || text.includes('[hash]') ||
                text.includes('Cascade') || text.includes('get_links') ||
                text.includes('agent_activity') ||
                text.includes('Ribosome Worker') || text.includes('handleCallZome') ||
                text.includes('>>> ') || text.includes('<<< ')) {
              extensionLogs.push(text.substring(0, 300));
              console.log(`[ext] ${text.substring(0, 300)}`);
            }
          });
        }
      }
    };
    captureExtensionLogs();
    // Also capture from pages that open later
    alice.context.on('page', (p) => {
      const url = p.url();
      if (url.includes('chrome-extension://')) {
        p.on('console', msg => {
          const text = msg.text();
          if (text.includes('[create_link]') || text.includes('[get_links]') ||
              text.includes('[create]') || text.includes('[hash]') ||
              text.includes('Cascade') || text.includes('get_links') ||
              text.includes('agent_activity') ||
              text.includes('Ribosome Worker') || text.includes('handleCallZome') ||
              text.includes('>>> ') || text.includes('<<< ')) {
            extensionLogs.push(text.substring(0, 300));
            console.log(`[ext] ${text.substring(0, 300)}`);
          }
        });
      }
    });

    const bobPageErrors: string[] = [];
    bob.page.on('pageerror', error => {
      const msg = `${error.name}: ${error.message}\n${error.stack}`;
      bobPageErrors.push(msg);
      console.log('[test] BOB PAGE ERROR:', msg);
    });

    // Also capture Bob's extension logs (offscreen document)
    const bobExtensionLogs: string[] = [];
    const captureBobExtensionLogs = () => {
      for (const p of bob.context.pages()) {
        const url = p.url();
        if (url.includes('chrome-extension://') && !url.includes('mewsfeed')) {
          p.on('console', msg => {
            const text = msg.text();
            if (text.includes('[get_links]') || text.includes('[get_details]') ||
                text.includes('[get]') || text.includes('[count_links]') ||
                text.includes('[HostFn:call]') || text.includes('Cascade') ||
                text.includes('Publish') || text.includes('SyncXHR') ||
                text.includes('Ribosome Worker') || text.includes('handleCallZome') ||
                text.includes('>>> ') || text.includes('<<< ') ||
                text.includes('🌐') || text.includes('🔗')) {
              bobExtensionLogs.push(text.substring(0, 400));
              console.log(`[bob-ext] ${text.substring(0, 400)}`);
            }
          });
        }
      }
    };
    captureBobExtensionLogs();
    bob.context.on('page', (p) => {
      const url = p.url();
      if (url.includes('chrome-extension://')) {
        p.on('console', msg => {
          const text = msg.text();
          if (text.includes('[get_links]') || text.includes('[get_details]') ||
              text.includes('[get]') || text.includes('[count_links]') ||
              text.includes('[HostFn:call]') || text.includes('Cascade') ||
              text.includes('Publish') || text.includes('SyncXHR') ||
              text.includes('Ribosome Worker') || text.includes('handleCallZome') ||
              text.includes('>>> ') || text.includes('<<< ') ||
              text.includes('🌐') || text.includes('🔗')) {
            bobExtensionLogs.push(text.substring(0, 400));
            console.log(`[bob-ext] ${text.substring(0, 400)}`);
          }
        });
      }
    });

    // Also expand Alice's extension log capture to include publish logs
    const captureAlicePublishLogs = () => {
      for (const p of alice.context.pages()) {
        const url = p.url();
        if (url.includes('chrome-extension://') && !url.includes('mewsfeed')) {
          p.on('console', msg => {
            const text = msg.text();
            if (text.includes('Publish') || text.includes('publish') ||
                text.includes('🌐') || text.includes('🔗')) {
              console.log(`[alice-ext-pub] ${text.substring(0, 300)}`);
            }
          });
        }
      }
    };
    captureAlicePublishLogs();
    alice.context.on('page', (p) => {
      const url = p.url();
      if (url.includes('chrome-extension://')) {
        p.on('console', msg => {
          const text = msg.text();
          if (text.includes('Publish') || text.includes('publish') ||
              text.includes('🌐') || text.includes('🔗')) {
            console.log(`[alice-ext-pub] ${text.substring(0, 300)}`);
          }
        });
      }
    });

    // --- Navigate both agents to mewsfeed UI ---
    // Navigate to root first so the extension detects the domain and installs the hApp
    console.log('[test] Navigating alice to mewsfeed UI...');
    await alice.page.goto(MEWSFEED_UI_URL);
    console.log('[test] Navigating bob to mewsfeed UI...');
    await bob.page.goto(MEWSFEED_UI_URL);

    // --- Wait for fishy extension to be ready on both pages ---
    console.log('[test] Waiting for extension ready on alice...');
    await waitForExtensionReady(alice.page, 60000);
    console.log('[test] Waiting for extension ready on bob...');
    await waitForExtensionReady(bob.page, 60000);

    // Give the app time to install hApp, initialize WASM, and render
    console.log('[test] Waiting for app initialization...');
    await alice.page.waitForTimeout(15000);

    // --- Navigate to /feed explicitly ---
    // The root "/" redirects to /discover for new users, but CreateMewInput
    // (with its "Send Mew" button) only renders on the /feed route.
    // Use client-side navigation since the static server only serves files.
    console.log('[test] Navigating alice to /feed...');
    await alice.page.evaluate(() => {
      history.pushState({}, '', '/feed');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await alice.page.waitForTimeout(3000);
    console.log('[test] Navigating bob to /feed...');
    await bob.page.evaluate(() => {
      history.pushState({}, '', '/feed');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await bob.page.waitForTimeout(3000);

    // Wait for the contenteditable mew input to appear (confirms CreateMewInput rendered)
    console.log('[test] Waiting for alice CreateMewInput...');
    const mewInputSelector = '[data-placeholder="What\'s mewing on?"]';
    try {
      await alice.page.locator(mewInputSelector).first()
        .waitFor({ state: 'visible', timeout: 30000 });
    } catch (e) {
      await alice.page.screenshot({ path: '/tmp/alice-mewsfeed-debug.png', fullPage: true });
      console.log('[test] Screenshot saved to /tmp/alice-mewsfeed-debug.png');
      console.log('[test] Alice URL:', alice.page.url());
      console.log('[test] Alice body (500):', (await alice.page.textContent('body'))?.substring(0, 500));
      console.log('[test] Alice page errors:', alicePageErrors);
      console.log('[test] Alice console errors:', aliceErrors.slice(-20));
      throw e;
    }
    console.log('[test] Alice CreateMewInput visible');

    console.log('[test] Waiting for bob CreateMewInput...');
    await bob.page.locator(mewInputSelector).first()
      .waitFor({ state: 'visible', timeout: 30000 });
    console.log('[test] Bob CreateMewInput visible');

    // --- Both agents create profiles ---
    // Profile creation is triggered by clicking "Send Mew" (shows profile dialog)
    console.log('[test] Creating profile for alice...');
    await createMewsfeedProfile(alice.page, 'alice');
    console.log('[test] Creating profile for bob...');
    await createMewsfeedProfile(bob.page, 'bobcat');

    // --- Test get_agent_activity via get_joining_timestamp_for_agent ---
    // This exercises the full get_agent_activity host function:
    // fishy WASM → host_fn → SyncXHR → linker → kitsune → conductor
    // The zome function queries for AgentValidationPkg actions (genesis)
    // and returns the timestamp of the first one.
    console.log('[test] Testing get_agent_activity via get_joining_timestamp_for_agent...');

    // Get Alice's agent pubkey from her cell_id
    const aliceAgentPubKey = await alice.page.evaluate(async () => {
      const holochain = (window as any).holochain;
      const appInfo = await holochain.appInfo('mewsfeed');
      if (!appInfo?.cells?.[0]) throw new Error('No mewsfeed app installed');
      return appInfo.cells[0][1]; // cell_id[1] = agent pubkey
    });
    console.log('[test] Alice agent pubkey obtained:', typeof aliceAgentPubKey, JSON.stringify(aliceAgentPubKey)?.substring(0, 80));

    // Call get_joining_timestamp_for_agent for Alice's own agent
    // This calls get_agent_activity internally with ActivityRequest::Full
    let joiningTimestamp: any = null;
    try {
      joiningTimestamp = await callZome(alice.page, {
        zomeName: 'profiles',
        fnName: 'get_joining_timestamp_for_agent',
        payload: { input: aliceAgentPubKey, local: false },
        appId: 'mewsfeed',
      });
      console.log('[test] get_joining_timestamp_for_agent result:', JSON.stringify(joiningTimestamp));
    } catch (e: any) {
      console.log('[test] get_joining_timestamp_for_agent ERROR:', e.message?.substring(0, 500));
    }

    // The timestamp should be non-null since Alice has genesis actions
    // It should be a number (microseconds since epoch) or a [seconds, nanos] tuple
    expect(joiningTimestamp, 'get_joining_timestamp_for_agent should return a timestamp for an agent with genesis actions').not.toBeNull();
    console.log('[test] get_agent_activity verified: joining timestamp returned successfully');

    // After profile creation, navigate back to /feed to ensure CreateMewInput is rendered
    console.log('[test] Re-navigating alice to /feed after profile creation...');
    await alice.page.evaluate(() => {
      history.pushState({}, '', '/feed');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await alice.page.waitForTimeout(3000);

    // --- Alice creates a mew with a hashtag ---
    console.log('[test] Alice creating mew with hashtag...');

    // Capture errors during mew creation
    const mewCreationErrors: string[] = [];
    const mewCreationLogs: string[] = [];
    const mewConsoleHandler = (msg: any) => {
      const text = msg.text();
      mewCreationLogs.push(`[${msg.type()}] ${text}`);
      if (msg.type() === 'error') mewCreationErrors.push(text);
    };
    alice.page.on('console', mewConsoleHandler);

    await createMew(alice.page, MEW_TEXT);

    // Check for mew creation errors
    if (mewCreationErrors.length > 0) {
      console.log('[test] Mew creation errors:', mewCreationErrors);
    }
    console.log('[test] Mew creation logs:', mewCreationLogs.slice(-20));
    alice.page.off('console', mewConsoleHandler);

    // Verify alice can see her own mew on the feed page
    console.log('[test] Verifying alice can see her mew on feed...');
    await alice.page.evaluate(() => {
      history.pushState({}, '', '/feed');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await alice.page.waitForTimeout(5000);
    const aliceFeedText = (await alice.page.textContent('body')) || '';
    const aliceCanSeeMew = aliceFeedText.includes('fishy extension');
    console.log(`[test] Alice can see own mew: ${aliceCanSeeMew}`);
    console.log('[test] Alice feed body (300):', aliceFeedText.substring(0, 300));
    if (!aliceCanSeeMew) {
      await alice.page.screenshot({ path: '/tmp/alice-after-mew.png', fullPage: true });
      console.log('[test] Screenshot saved to /tmp/alice-after-mew.png');
    }

    // --- Diagnostic: direct callZome to check hashtag indexing ---
    console.log('[test] Running callZome diagnostics...');

    // 1. Create a mew via callZome to get a hash for subsequent diagnostics
    // (get_all_mew_hashes is not an #[hdk_extern] export, so we create directly)
    let mewHash: any = null;
    try {
      mewHash = await callZome(alice.page, {
        zomeName: 'mews',
        fnName: 'create_mew',
        payload: { text: 'Diagnostic mew #diagnostictag', links: [], mew_type: 'Original' },
        appId: 'mewsfeed',
      });
      console.log('[test] create_mew for diagnostics result:', JSON.stringify(mewHash)?.substring(0, 200));
    } catch (e: any) {
      console.log('[test] create_mew for diagnostics ERROR:', e.message?.substring(0, 500));
    }

    // 2. Try add_hashtag_for_mew directly - this exercises typed path ensure()
    if (mewHash) {
      try {
        await callZome(alice.page, {
          zomeName: 'mews',
          fnName: 'add_hashtag_for_mew',
          payload: { base_hashtag: '#diagnostic', target_mew_hash: mewHash },
          appId: 'mewsfeed',
        });
        console.log('[test] add_hashtag_for_mew("#diagnostic") SUCCEEDED');
      } catch (e: any) {
        console.log('[test] add_hashtag_for_mew("#diagnostic") ERROR:', e.message?.substring(0, 500));
      }
    }

    // 3. Search for the diagnostic hashtag we just added
    try {
      const searchResult = await callZome(alice.page, {
        zomeName: 'mews',
        fnName: 'search_tags',
        payload: { input: { query: 'dia', limit: 10 }, local: true },
        appId: 'mewsfeed',
      });
      console.log('[test] search_tags("dia") result:', JSON.stringify(searchResult));
    } catch (e: any) {
      console.log('[test] search_tags("dia") ERROR:', e.message?.substring(0, 500));
    }

    // 4. Search for original hashtag
    try {
      const searchResult = await callZome(alice.page, {
        zomeName: 'mews',
        fnName: 'search_tags',
        payload: { input: { query: 'tes', limit: 10 }, local: true },
        appId: 'mewsfeed',
      });
      console.log('[test] search_tags("tes") result:', JSON.stringify(searchResult));
    } catch (e: any) {
      console.log('[test] search_tags("tes") ERROR:', e.message?.substring(0, 500));
    }

    // 5. Check get_mews_for_hashtag for both
    for (const tag of [`#${TEST_HASHTAG}`, '#diagnostic']) {
      try {
        const hashtagResult = await callZome(alice.page, {
          zomeName: 'mews',
          fnName: 'get_mews_for_hashtag_with_context',
          payload: { input: { hashtag: tag, page: null }, local: true },
          appId: 'mewsfeed',
        });
        const count = Array.isArray(hashtagResult) ? hashtagResult.length : 'not array';
        console.log(`[test] get_mews_for_hashtag("${tag}") result count:`, count);
      } catch (e: any) {
        console.log(`[test] get_mews_for_hashtag("${tag}") ERROR:`, e.message?.substring(0, 500));
      }
    }

    // 6. Try create_mew directly via callZome (will exercise add_tags_for_mew)
    try {
      const directResult = await callZome(alice.page, {
        zomeName: 'mews',
        fnName: 'create_mew',
        payload: { text: 'Direct test #directtag', links: [], mew_type: 'Original' },
        appId: 'mewsfeed',
      });
      console.log('[test] create_mew direct result:', JSON.stringify(directResult)?.substring(0, 200));
    } catch (e: any) {
      console.log('[test] create_mew direct ERROR:', e.message?.substring(0, 500));
    }

    // 7. Now search for directtag
    try {
      const searchResult = await callZome(alice.page, {
        zomeName: 'mews',
        fnName: 'search_tags',
        payload: { input: { query: 'dir', limit: 10 }, local: true },
        appId: 'mewsfeed',
      });
      console.log('[test] search_tags("dir") result:', JSON.stringify(searchResult));
    } catch (e: any) {
      console.log('[test] search_tags("dir") ERROR:', e.message?.substring(0, 500));
    }

    // --- First check: can ALICE find her own mew via hashtag via UI? ---
    // This tests local hashtag path indexing (no DHT propagation needed)
    console.log(`[test] Checking if alice can find her mew via #${TEST_HASHTAG} (UI navigation)...`);
    await alice.page.evaluate((path: string) => {
      history.pushState({}, '', path);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, `/hashtag/${TEST_HASHTAG}`);
    await alice.page.waitForTimeout(5000);
    const aliceHashtagText = (await alice.page.textContent('body')) || '';
    const aliceCanFindHashtag = aliceHashtagText.includes('fishy extension');
    console.log(`[test] Alice hashtag search result: ${aliceCanFindHashtag}`);
    console.log('[test] Alice hashtag body (300):', aliceHashtagText.substring(0, 300));
    if (!aliceCanFindHashtag) {
      await alice.page.screenshot({ path: '/tmp/alice-hashtag-search.png', fullPage: true });
      console.log('[test] Alice also cannot find mew via hashtag - this is a local issue, not DHT propagation');
    }

    // --- Wait for DHT propagation ---
    console.log('[test] Waiting 30s for DHT propagation + publish completion...');
    await bob.page.waitForTimeout(30000);

    // --- Direct linker check: verify Alice's publish reached the DHT ---
    // This bypasses Bob's extension entirely to confirm data is in the network
    try {
      const { readFile: readFileAsync } = await import('fs/promises');
      const dnaHash = await readFileAsync('/tmp/hwc-e2e/dna_hash.txt', 'utf8').then((s: string) => s.trim());
      console.log(`[test] DNA hash from sandbox: ${dnaHash}`);

      // Use Bob's page to make a direct fetch to the linker health endpoint
      const linkerCheck = await bob.page.evaluate(async () => {
        try {
          const healthResp = await fetch('http://localhost:8000/health');
          const healthText = await healthResp.text();
          return { health: healthText, error: null };
        } catch (e: any) {
          return { health: null, error: e.message };
        }
      });
      console.log('[test] Linker health check:', JSON.stringify(linkerCheck));
    } catch (e: any) {
      console.log('[test] Linker check failed:', e.message);
    }

    // --- Also try Bob's zome call directly to search for the hashtag ---
    console.log('[test] Trying Bob callZome search_tags...');
    try {
      const bobSearchResult = await callZome(bob.page, {
        zomeName: 'mews',
        fnName: 'search_tags',
        payload: { input: { query: 'tes', limit: 10 }, local: false },
        appId: 'mewsfeed',
      });
      console.log('[test] Bob search_tags("tes") result:', JSON.stringify(bobSearchResult));
    } catch (e: any) {
      console.log('[test] Bob search_tags ERROR:', e.message?.substring(0, 500));
    }

    // Also try Bob's get_mews_for_hashtag directly
    try {
      const bobHashtagResult = await callZome(bob.page, {
        zomeName: 'mews',
        fnName: 'get_mews_for_hashtag_with_context',
        payload: { input: { hashtag: `#${TEST_HASHTAG}`, page: null }, local: false },
        appId: 'mewsfeed',
      });
      const count = Array.isArray(bobHashtagResult) ? bobHashtagResult.length : 'not array';
      console.log(`[test] Bob get_mews_for_hashtag("#${TEST_HASHTAG}") result count:`, count);
      if (Array.isArray(bobHashtagResult) && bobHashtagResult.length > 0) {
        console.log(`[test] Bob got mew:`, JSON.stringify(bobHashtagResult[0]).substring(0, 500));
      }
    } catch (e: any) {
      console.log(`[test] Bob get_mews_for_hashtag ERROR:`, e.message?.substring(0, 500));
    }

    // Log Bob's extension logs collected so far
    console.log(`[test] Bob extension logs (${bobExtensionLogs.length} entries, last 50):`);
    for (const log of bobExtensionLogs.slice(-50)) {
      console.log(`  ${log}`);
    }

    // --- Bob navigates to hashtag page and looks for the mew ---
    console.log(`[test] Bob searching for #${TEST_HASHTAG} via UI...`);
    await waitForHashtagResult(bob.page, TEST_HASHTAG, 'fishy extension', 120000);
    console.log('[test] Bob found Alice\'s mew via hashtag search');
  });
});
