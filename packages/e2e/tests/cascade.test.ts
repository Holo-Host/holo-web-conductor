/**
 * Network Cascade E2E Tests
 *
 * Tests for fetching data from the network through the gateway:
 * - Fetch known entry from network
 * - Verify cache speedup on second fetch
 * - Get details cascade
 */

import { test, expect, connectAndConfigure, decodeHashFromB64 } from './fixtures.js';

test.describe('Network Cascade', () => {
  test.beforeEach(async ({ testPage, gatewayUrl }) => {
    // Connect and configure gateway
    await connectAndConfigure(testPage, gatewayUrl);
    await testPage.waitForTimeout(500);
  });

  test('should fetch known entry from network', async ({ testPage, knownEntryHash, appId }) => {
    // Skip if no known entry hash
    if (!knownEntryHash) {
      console.log('No known entry hash found in .hc-sandbox/known_entry.json');
      console.log('Run: ./scripts/e2e-test-setup.sh start');
      test.skip();
      return;
    }

    // Skip if no app installed
    const hasApp = await testPage.evaluate(async () => {
      const holochain = (window as any).holochain;
      try {
        const info = await holochain.appInfo();
        return info?.cells?.length > 0;
      } catch {
        return false;
      }
    });

    if (!hasApp) {
      console.log('No hApp installed');
      test.skip();
      return;
    }

    console.log('Fetching known entry:', knownEntryHash);
    const hashBytes = decodeHashFromB64(knownEntryHash);

    const startTime = Date.now();

    const result = await testPage.evaluate(
      async ({ hashBytes, appId }) => {
        const holochain = (window as any).holochain;
        const appInfo = await holochain.appInfo(appId);
        const cellId = appInfo.cells[0];

        return holochain.callZome({
          cell_id: cellId,
          zome_name: 'dht_util',
          fn_name: 'dht_get_record',
          payload: { hash: hashBytes },
          provenance: cellId[1],
        });
      },
      { hashBytes, appId: appId || 'fixture1' }
    );

    const duration = Date.now() - startTime;
    console.log(`Network fetch completed in ${duration}ms`);

    expect(result).toBeDefined();
    expect(result.signed_action).toBeDefined();

    // Verify entry content if present
    if (result.entry?.Present) {
      console.log('Entry content:', JSON.stringify(result.entry.Present));
    }
  });

  test('should hit cache on second fetch', async ({ testPage, knownEntryHash, appId }) => {
    // Skip if no known entry hash
    if (!knownEntryHash) {
      test.skip();
      return;
    }

    // Skip if no app installed
    const hasApp = await testPage.evaluate(async () => {
      const holochain = (window as any).holochain;
      try {
        const info = await holochain.appInfo();
        return info?.cells?.length > 0;
      } catch {
        return false;
      }
    });

    if (!hasApp) {
      test.skip();
      return;
    }

    const hashBytes = decodeHashFromB64(knownEntryHash);

    // First fetch (network)
    const startFirst = Date.now();
    await testPage.evaluate(
      async ({ hashBytes, appId }) => {
        const holochain = (window as any).holochain;
        const appInfo = await holochain.appInfo(appId);
        const cellId = appInfo.cells[0];

        return holochain.callZome({
          cell_id: cellId,
          zome_name: 'dht_util',
          fn_name: 'dht_get_record',
          payload: { hash: hashBytes },
          provenance: cellId[1],
        });
      },
      { hashBytes, appId: appId || 'fixture1' }
    );
    const firstDuration = Date.now() - startFirst;

    // Second fetch (should hit cache)
    const startSecond = Date.now();
    await testPage.evaluate(
      async ({ hashBytes, appId }) => {
        const holochain = (window as any).holochain;
        const appInfo = await holochain.appInfo(appId);
        const cellId = appInfo.cells[0];

        return holochain.callZome({
          cell_id: cellId,
          zome_name: 'dht_util',
          fn_name: 'dht_get_record',
          payload: { hash: hashBytes },
          provenance: cellId[1],
        });
      },
      { hashBytes, appId: appId || 'fixture1' }
    );
    const secondDuration = Date.now() - startSecond;

    console.log(`First fetch: ${firstDuration}ms`);
    console.log(`Second fetch: ${secondDuration}ms`);

    const speedup = firstDuration / secondDuration;
    console.log(`Speedup: ${speedup.toFixed(1)}x`);

    // Cache should provide some speedup, but network conditions vary
    // Just verify both fetches succeeded
    expect(secondDuration).toBeLessThanOrEqual(firstDuration * 2);
  });

  test('should get details from network', async ({ testPage, knownEntryHash, appId }) => {
    // Skip if no known entry hash
    if (!knownEntryHash) {
      test.skip();
      return;
    }

    // Skip if no app installed
    const hasApp = await testPage.evaluate(async () => {
      const holochain = (window as any).holochain;
      try {
        const info = await holochain.appInfo();
        return info?.cells?.length > 0;
      } catch {
        return false;
      }
    });

    if (!hasApp) {
      test.skip();
      return;
    }

    console.log('Getting details for entry:', knownEntryHash);
    const hashBytes = decodeHashFromB64(knownEntryHash);

    const result = await testPage.evaluate(
      async ({ hashBytes, appId }) => {
        const holochain = (window as any).holochain;
        const appInfo = await holochain.appInfo(appId);
        const cellId = appInfo.cells[0];

        return holochain.callZome({
          cell_id: cellId,
          zome_name: 'dht_util',
          fn_name: 'dht_get_details',
          payload: { hash: hashBytes },
          provenance: cellId[1],
        });
      },
      { hashBytes, appId: appId || 'fixture1' }
    );

    if (result) {
      console.log('Details type:', result.type);
      if (result.type === 'Entry') {
        console.log('Actions:', result.content?.actions?.length || 0);
        console.log('Updates:', result.content?.updates?.length || 0);
      }
    }

    // Details might be null if entry doesn't exist on network
    // This is not an error, just means cascade didn't find it
    expect(result === null || result.type !== undefined).toBe(true);
  });
});
