/**
 * Connection Status E2E Test (Cross-Browser)
 *
 * Verifies that connection status transitions correctly when the linker
 * is paused and unpaused. Tests both Chrome and Firefox simultaneously.
 *
 * Transitions tested:
 *   connected/authenticated -> linker stopped -> wsHealthy:false -> linker restarted -> wsHealthy:true, authenticated:true
 *
 * Prerequisites:
 * 1. Run: ./scripts/e2e-test-setup.sh start --happ=ziptest
 * 2. Both extensions built: npm run build:extension
 * 3. Test pages served at http://localhost:3333 (packages/extension/test/)
 */

import { test, expect } from '@playwright/test';
import {
  createAgentContext,
  cleanupAgentContext,
  waitForExtensionReady,
  LINKER_URL,
  type AgentContext,
} from './fixtures.js';
import { EnvironmentManager } from '../src/environment.js';

const TEST_PAGE_URL = 'http://localhost:3333/happ-test.html';
const TEST_HAPP_URL = 'http://localhost:3333/test.happ';
const APP_ID = 'conn-test';

const env = new EnvironmentManager({ happ: 'ziptest' });

/** Install hApp and configure linker on a page */
async function installAndConfigure(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(
    async ({ happUrl, appId, linkerUrl }) => {
      const holochain = (window as any).holochain;
      await holochain.connect();
      const resp = await fetch(happUrl);
      const buf = await resp.arrayBuffer();
      const bytes = Array.from(new Uint8Array(buf));
      await holochain.installApp({ bundle: bytes, installedAppId: appId });
      await holochain.configureNetwork({ linkerUrl });
    },
    { happUrl: TEST_HAPP_URL, appId: APP_ID, linkerUrl: LINKER_URL },
  );
}

/** Poll getConnectionStatus() until fields match expected values */
async function waitForStatusFields(
  page: import('@playwright/test').Page,
  expected: Record<string, any>,
  timeout = 60000,
): Promise<any> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const status = await page.evaluate(async () =>
      (window as any).holochain.getConnectionStatus(),
    );
    const match = Object.entries(expected).every(([k, v]) => (status as any)[k] === v);
    if (match) return status;
    await page.waitForTimeout(2000);
  }
  // Final attempt — if still fails, return for assertion to report
  return page.evaluate(async () => (window as any).holochain.getConnectionStatus());
}

/** Set up transition collector and visible status overlay on a page */
async function startCollectingTransitions(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    // Create visible status overlay
    const overlay = document.createElement('div');
    overlay.id = '__conn-status-overlay';
    overlay.style.cssText =
      'position:fixed;top:10px;right:10px;z-index:99999;padding:12px 16px;' +
      'border-radius:8px;font:14px/1.4 monospace;background:#1e1e1e;color:#ccc;' +
      'border:2px solid #444;min-width:280px;box-shadow:0 4px 12px rgba(0,0,0,0.3);';
    overlay.innerHTML = '<div style="font-weight:bold;margin-bottom:6px;color:#fff;">Connection Status</div>' +
      '<div id="__conn-fields"></div>' +
      '<div id="__conn-log" style="margin-top:8px;max-height:200px;overflow-y:auto;font-size:12px;border-top:1px solid #444;padding-top:6px;"></div>';
    document.body.appendChild(overlay);

    function updateOverlay(status: any) {
      const fields = document.getElementById('__conn-fields');
      if (!fields) return;
      const wsColor = status.wsHealthy ? '#4ade80' : '#f87171';
      const authColor = status.authenticated ? '#4ade80' : '#f87171';
      const httpColor = status.httpHealthy ? '#4ade80' : '#f87171';
      fields.innerHTML =
        `<div>WS: <span style="color:${wsColor};font-weight:bold">${status.wsHealthy ? 'connected' : 'disconnected'}</span></div>` +
        `<div>Auth: <span style="color:${authColor};font-weight:bold">${status.authenticated}</span></div>` +
        `<div>HTTP: <span style="color:${httpColor};font-weight:bold">${status.httpHealthy}</span></div>` +
        `<div>Peers: ${status.peerCount ?? 'n/a'}</div>` +
        (status.lastError ? `<div style="color:#f87171">Error: ${status.lastError}</div>` : '');

      const log = document.getElementById('__conn-log');
      if (log) {
        const entry = document.createElement('div');
        const time = new Date().toLocaleTimeString();
        entry.textContent = `${time} ws=${status.wsHealthy} auth=${status.authenticated} http=${status.httpHealthy}`;
        entry.style.color = status.wsHealthy ? '#4ade80' : '#f87171';
        log.appendChild(entry);
        log.scrollTop = log.scrollHeight;
      }
    }

    // Show initial state
    (window as any).holochain.getConnectionStatus().then(updateOverlay);

    (window as any).__connectionTransitions = [];
    (window as any).__unsubConnectionStatus = (window as any).holochain.onConnectionChange(
      (status: any) => {
        (window as any).__connectionTransitions.push({
          ...status,
          _capturedAt: Date.now(),
        });
        updateOverlay(status);
      },
    );
  });
}

/** Get collected transitions from a page */
async function getTransitions(page: import('@playwright/test').Page): Promise<any[]> {
  return page.evaluate(() => (window as any).__connectionTransitions);
}

/** Clean up transition collector */
async function stopCollectingTransitions(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const unsub = (window as any).__unsubConnectionStatus;
    if (typeof unsub === 'function') unsub();
  });
}

test.describe('connection status transitions (Chrome + Firefox)', () => {
  let alice: AgentContext;
  let bob: AgentContext;

  test.beforeAll(async () => {
    alice = await createAgentContext('conn-alice', 'chrome');
    bob = await createAgentContext('conn-bob', 'firefox');
  });

  test.afterAll(async () => {
    if (alice) await cleanupAgentContext(alice);
    if (bob) await cleanupAgentContext(bob);
  });

  test('both browsers see status transitions during linker pause/unpause', async () => {
    test.setTimeout(300000);

    const pages = [
      { name: 'alice (chrome)', page: alice.page },
      { name: 'bob (firefox)', page: bob.page },
    ];

    // --- Setup: navigate, install, configure ---
    for (const { name, page } of pages) {
      console.log(`[test] ${name}: navigating to test page`);
      await page.goto(TEST_PAGE_URL);
      console.log(`[test] ${name}: waiting for extension`);
      await waitForExtensionReady(page, 30000);
      console.log(`[test] ${name}: installing hApp and configuring network`);
      await installAndConfigure(page);
    }

    // --- Verify initial connected state ---
    for (const { name, page } of pages) {
      console.log(`[test] ${name}: waiting for connected state`);
      const status = await waitForStatusFields(page, { wsHealthy: true, authenticated: true });
      console.log(`[test] ${name}: initial status: ${JSON.stringify(status)}`);
      expect(status.wsHealthy).toBe(true);
      expect(status.authenticated).toBe(true);
    }

    // --- Start collecting transitions ---
    for (const { name, page } of pages) {
      console.log(`[test] ${name}: starting transition collector`);
      await startCollectingTransitions(page);
    }

    // Pause so the connected state is visible in the overlay
    console.log('[test] Connected state visible — waiting 5s before pausing linker');
    await alice.page.waitForTimeout(5000);

    // --- Pause linker ---
    console.log('[test] Pausing linker');
    await env.pauseLinker();

    // --- Verify disconnect on both browsers ---
    for (const { name, page } of pages) {
      console.log(`[test] ${name}: waiting for wsHealthy=false`);
      const status = await waitForStatusFields(page, { wsHealthy: false }, 60000);
      console.log(`[test] ${name}: disconnected status: ${JSON.stringify(status)}`);
      expect(status.wsHealthy).toBe(false);

      const transitions = await getTransitions(page);
      console.log(`[test] ${name}: ${transitions.length} transition(s) after pause`);
      expect(transitions.length).toBeGreaterThan(0);
      expect(transitions.some((t: any) => t.wsHealthy === false)).toBe(true);
    }

    // Pause so the disconnected state is visible in the overlay
    console.log('[test] Disconnected state visible — waiting 5s before unpausing');
    await alice.page.waitForTimeout(5000);

    // --- Unpause linker ---
    console.log('[test] Unpausing linker');
    await env.unpauseLinker();

    // --- Verify reconnect on both browsers ---
    for (const { name, page } of pages) {
      console.log(`[test] ${name}: waiting for wsHealthy=true, authenticated=true`);
      const status = await waitForStatusFields(page, { wsHealthy: true, authenticated: true }, 120000);
      console.log(`[test] ${name}: reconnected status: ${JSON.stringify(status)}`);
      expect(status.wsHealthy).toBe(true);
      expect(status.authenticated).toBe(true);

      const transitions = await getTransitions(page);
      console.log(`[test] ${name}: ${transitions.length} total transition(s)`);
      expect(transitions.some((t: any) => t.wsHealthy === true && t.authenticated === true)).toBe(true);
    }

    // Pause so the reconnected state is visible in the overlay
    console.log('[test] Reconnected state visible — waiting 5s before cleanup');
    await alice.page.waitForTimeout(5000);

    // --- Cleanup listeners ---
    for (const { page } of pages) {
      await stopCollectingTransitions(page);
    }

    console.log('[test] Connection status test passed');
  });
});
