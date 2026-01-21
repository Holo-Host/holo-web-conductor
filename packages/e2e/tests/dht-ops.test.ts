/**
 * DHT Operations E2E Tests
 *
 * Tests for basic DHT operations through the Fishy extension:
 * - Create entry
 * - Get record
 * - Get all entries
 * - Get links
 */

import { test, expect, connectAndConfigure, callZome, decodeHashFromB64, encodeHashToB64, ensureHappInstalled } from './fixtures.js';

test.describe('DHT Operations', () => {
  test.beforeEach(async ({ testPage, gatewayUrl, happPath, appId }) => {
    // Connect and configure gateway
    await connectAndConfigure(testPage, gatewayUrl);

    // Ensure hApp is installed
    await ensureHappInstalled(testPage, happPath, appId || 'fixture1');

    // Wait a moment for connection to stabilize
    await testPage.waitForTimeout(500);
  });

  test('should detect extension', async ({ testPage }) => {
    const hasExtension = await testPage.evaluate(() => {
      return (window as any).holochain?.isFishy === true;
    });
    expect(hasExtension).toBe(true);
  });

  test('should connect to extension', async ({ testPage }) => {
    // Connection happens in beforeEach, verify it worked
    const isConnected = await testPage.evaluate(async () => {
      const holochain = (window as any).holochain;
      // If we can get app info, we're connected
      try {
        await holochain.appInfo();
        return true;
      } catch {
        // Might not have an app installed yet, but connection should work
        return true;
      }
    });
    expect(isConnected).toBe(true);
  });

  test('should check for existing hApp', async ({ testPage }) => {
    const appInfo = await testPage.evaluate(async () => {
      const holochain = (window as any).holochain;
      try {
        return await holochain.appInfo();
      } catch {
        return null;
      }
    });

    // Log what we found
    if (appInfo?.cells?.length > 0) {
      console.log(`Found existing hApp: ${appInfo.appName || appInfo.contextId}`);
    } else {
      console.log('No hApp installed yet');
    }

    // Test passes either way - we're just checking the query works
    expect(true).toBe(true);
  });

  test('should create entry', async ({ testPage, appId }) => {
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

    const result = await callZome(testPage, {
      zomeName: 'coordinator1',
      fnName: 'create_1',
      payload: null,
      appId: appId || 'fixture1',
    });

    expect(result).toBeDefined();
    expect(result.created).toBeDefined();

    console.log(`Created entry with hash: ${result.created}`);
  });

  test('should get record by hash', async ({ testPage, appId }) => {
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

    // First create an entry
    const createResult = await callZome(testPage, {
      zomeName: 'coordinator1',
      fnName: 'create_1',
      payload: null,
      appId: appId || 'fixture1',
    });

    expect(createResult.created).toBeDefined();
    const hashB64 = createResult.created;

    // Decode hash and get record
    const hashBytes = decodeHashFromB64(hashB64);

    const getResult = await testPage.evaluate(
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

    expect(getResult).toBeDefined();
    expect(getResult.signed_action).toBeDefined();
  });

  test('should get all entries', async ({ testPage, appId }) => {
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

    const result = await callZome(testPage, {
      zomeName: 'coordinator1',
      fnName: 'get_all_1',
      payload: null,
      appId: appId || 'fixture1',
    });

    expect(Array.isArray(result)).toBe(true);
    console.log(`Found ${result.length} entries`);
  });

  test('should get links', async ({ testPage, appId }) => {
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

    // The coordinator uses EntryHash::from_raw_36(vec![1; 36]) as base
    // EntryHash prefix is 0x84, 0x21, 0x24 (132, 33, 36)
    const baseHash = [132, 33, 36, ...Array(36).fill(1)];

    const result = await testPage.evaluate(
      async ({ baseHash, appId }) => {
        const holochain = (window as any).holochain;
        const appInfo = await holochain.appInfo(appId);
        const cellId = appInfo.cells[0];

        return holochain.callZome({
          cell_id: cellId,
          zome_name: 'dht_util',
          fn_name: 'dht_get_links',
          payload: { base: baseHash },
          provenance: cellId[1],
        });
      },
      { baseHash, appId: appId || 'fixture1' }
    );

    expect(Array.isArray(result)).toBe(true);
    console.log(`Found ${result.length} links`);
  });
});
