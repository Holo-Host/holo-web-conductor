/**
 * Shared test utilities for HWC manual test pages.
 *
 * Usage (in an HTML page with <script type="module">):
 *   import { log, showStatus, formatForDisplay, TestRunner } from './lib/test-helpers.js';
 *
 * Requires importmap for @holochain/client:
 *   <script type="importmap">
 *     { "imports": { "@holochain/client": "https://esm.sh/@holochain/client@0.20.1" } }
 *   </script>
 */

import { encodeHashToBase64 } from '@holochain/client';
import { decode as msgpackDecode } from 'https://esm.sh/@msgpack/msgpack@3.0.0-beta2';

// Re-export msgpackDecode so pages don't need a separate import
export { msgpackDecode };

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * Append a timestamped log line to a <pre> or .output element and to console.
 *
 * @param {HTMLElement} outputEl - DOM element to append to
 * @param {string} message - Log text
 * @param {boolean} isError - Prefix with error marker
 */
export function log(outputEl, message, isError = false) {
  const timestamp = new Date().toLocaleTimeString();
  const prefix = isError ? 'ERROR' : '';
  const line = prefix ? `[${timestamp}] ${prefix} ${message}` : `[${timestamp}] ${message}`;
  outputEl.textContent += line + '\n';
  outputEl.scrollTop = outputEl.scrollHeight;
  if (isError) {
    console.error(message);
  } else {
    console.log(message);
  }
}

// ---------------------------------------------------------------------------
// Status badges
// ---------------------------------------------------------------------------

/**
 * Set the inner HTML of a status container.
 *
 * @param {string} elementId - ID of the container element
 * @param {string} message - HTML content
 * @param {'success'|'error'|'info'|'warning'} type - CSS class suffix
 */
export function showStatus(elementId, message, type) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.innerHTML = `<div class="status ${type}">${message}</div>`;
}

// ---------------------------------------------------------------------------
// Byte array helpers
// ---------------------------------------------------------------------------

/**
 * If `value` is a plain Array that looks like a 39-byte HoloHash, return it
 * as a Uint8Array. Otherwise return the original value unchanged.
 */
export function maybeUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value) && value.length === 39 && value[0] === 132 && value[2] === 36) {
    return new Uint8Array(value);
  }
  return value;
}

/** Convert bytes to a hex string. */
export function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Display formatting
// ---------------------------------------------------------------------------

/**
 * Recursively format a value for human-readable display:
 * - 39-byte hashes  → base64 via encodeHashToBase64
 * - 64-byte arrays  → hex (likely signatures)
 * - Other byte data → abbreviated Uint8Array(N)
 * - Objects/arrays  → recurse
 */
export function formatForDisplay(value) {
  if (value == null) return value;

  const normalized = maybeUint8Array(value);

  if (normalized instanceof Uint8Array) {
    if (normalized.length === 39 && normalized[0] === 132 && normalized[2] === 36) {
      try { return encodeHashToBase64(normalized); } catch { return `Uint8Array(${normalized.length})`; }
    }
    if (normalized.length === 64) return bytesToHex(normalized);
    return `Uint8Array(${normalized.length}): [${Array.from(normalized.slice(0, 8)).join(',')}...]`;
  }

  if (Array.isArray(value)) {
    const isByteArray = value.length > 0 && value.every(v => typeof v === 'number' && v >= 0 && v <= 255);
    if (isByteArray) {
      if (value.length === 39 && value[0] === 132 && value[2] === 36) {
        try { return encodeHashToBase64(new Uint8Array(value)); } catch { /* fall through */ }
      }
      if (value.length === 64) return bytesToHex(value);
    }
    return value.map(formatForDisplay);
  }

  if (typeof value === 'object') {
    const result = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = formatForDisplay(val);
    }
    return result;
  }

  return value;
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

/**
 * Sequential test runner with pass/fail tracking.
 *
 * Usage:
 *   const runner = new TestRunner(outputEl);
 *   await runner.run('get_agent_info', async () => { ... });
 *   await runner.run('create_entry', async () => { ... });
 *   runner.showSummary(summaryEl);
 */
export class TestRunner {
  constructor(outputEl) {
    this.outputEl = outputEl;
    this.results = []; // { name, passed, error? }
  }

  /**
   * Run a single named test. The test function should throw on failure.
   * Returns the value returned by `fn` on success, or undefined on failure.
   */
  async run(name, fn) {
    log(this.outputEl, `--- ${name} ---`);
    try {
      const result = await fn();
      this.results.push({ name, passed: true });
      log(this.outputEl, `PASS ${name}`);
      return result;
    } catch (error) {
      this.results.push({ name, passed: false, error: error.message });
      log(this.outputEl, `FAIL ${name}: ${error.message}`, true);
      return undefined;
    }
  }

  /** Render a summary into a DOM element. */
  showSummary(el) {
    const passed = this.results.filter(r => r.passed).length;
    const total = this.results.length;
    const failed = total - passed;

    let html = `<h3>${passed}/${total} passed</h3>`;
    if (failed > 0) {
      html += '<ul style="color:#721c24; margin:8px 0;">';
      for (const r of this.results.filter(r => !r.passed)) {
        html += `<li><strong>${r.name}</strong>: ${r.error}</li>`;
      }
      html += '</ul>';
    }

    el.innerHTML = html;
    el.className = failed === 0 ? 'status success' : 'status error';
  }

  /** Reset results for a fresh run. */
  reset() {
    this.results = [];
  }
}

// ---------------------------------------------------------------------------
// Extension detection
// ---------------------------------------------------------------------------

/**
 * Wait for the Holochain extension to be available.
 * Resolves when `window.holochain` exists, rejects after timeout.
 *
 * @param {number} timeoutMs - Max wait time (default 3000)
 * @returns {Promise<void>}
 */
export function waitForExtension(timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    if (typeof window.holochain !== 'undefined') {
      resolve();
      return;
    }

    const onReady = () => {
      clearTimeout(timer);
      resolve();
    };

    window.addEventListener('holochain:ready', onReady, { once: true });

    const timer = setTimeout(() => {
      window.removeEventListener('holochain:ready', onReady);
      if (typeof window.holochain !== 'undefined') {
        resolve();
      } else {
        reject(new Error('Holochain extension not detected'));
      }
    }, timeoutMs);
  });
}

/**
 * Load a file as Uint8Array from a URL (cache-busted).
 *
 * @param {string} url - URL to fetch
 * @returns {Promise<Uint8Array>}
 */
export async function loadBinaryFile(url) {
  const response = await fetch(url + '?v=' + Date.now());
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}
