/**
 * Centralized logging utility with filterable prefixes
 *
 * Usage:
 *   import { createLogger, setLogFilter } from '@hwc/shared';
 *   const log = createLogger('Background');
 *   log.info('message');  // [Background] message
 *   log.debug('details'); // Only shows if 'Background' matches filter
 *
 * Runtime filter control (in any extension console):
 *   setHwcLogFilter('Background,Offscreen'); // Show only these
 *   setHwcLogFilter('*'); // Show all (default)
 *   setHwcLogFilter(''); // Show none
 *
 * Filter syncs across all contexts (background, offscreen, worker) via chrome.runtime messaging
 */

// Global filter - comma-separated list of prefixes to show, '*' for all, '' for none
declare global {
  interface Window {
    hwcLogFilter?: string;
  }
  var hwcLogFilter: string | undefined;
  // Chrome extension API (optional - only available in extension contexts)
  var chrome: {
    storage?: {
      local?: {
        get: (keys: string[]) => Promise<Record<string, unknown>>;
        set: (items: Record<string, unknown>) => Promise<void>;
      };
    };
    runtime?: {
      sendMessage: (message: unknown) => Promise<void>;
      onMessage?: {
        addListener: (callback: (message: unknown) => void) => void;
      };
    };
  } | undefined;
}

// Message type for log filter changes
const LOG_FILTER_MESSAGE_TYPE = 'HWC_LOG_FILTER_CHANGE';

// Initialize filter on globalThis if not set
if (typeof globalThis !== 'undefined' && globalThis.hwcLogFilter === undefined) {
  globalThis.hwcLogFilter = '*'; // Default until loaded from storage
}

// Load filter from storage on init (for persistence across restarts)
// Only in extension contexts where chrome.storage is available
if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
  chrome.storage.local.get(['hwcLogFilter']).then((result: Record<string, unknown>) => {
    if (typeof result.hwcLogFilter === 'string') {
      globalThis.hwcLogFilter = result.hwcLogFilter;
    }
  }).catch(() => {});
}

// Listen for filter changes from other contexts via runtime messaging
// Only in extension contexts where chrome.runtime is available
if (typeof chrome !== 'undefined' && chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (message && typeof message === 'object' && 'type' in message && 'filter' in message) {
      const msg = message as { type: string; filter: string };
      if (msg.type === LOG_FILTER_MESSAGE_TYPE) {
        globalThis.hwcLogFilter = msg.filter;
      }
    }
  });
}

/**
 * Check if a prefix should be logged based on the current filter
 */
function shouldLog(prefix: string): boolean {
  const filter = globalThis.hwcLogFilter ?? '*';
  if (filter === '*') return true;
  if (filter === '') return false;

  const allowedPrefixes = filter.split(',').map(p => p.trim().toLowerCase());
  const prefixLower = prefix.toLowerCase();
  return allowedPrefixes.some(allowed =>
    prefixLower.includes(allowed) || allowed.includes(prefixLower)
  );
}

/**
 * Set the log filter at runtime - syncs across all contexts
 */
export function setLogFilter(filter: string): void {
  globalThis.hwcLogFilter = filter;
  console.log(`[Logger] Filter set to: ${filter === '*' ? 'all' : filter === '' ? 'none' : filter}`);

  if (typeof chrome !== 'undefined') {
    // Persist to storage for persistence across restarts
    if (chrome.storage?.local) {
      chrome.storage.local.set({ hwcLogFilter: filter }).catch(() => {});
    }

    // Broadcast to all extension contexts via runtime messaging
    if (chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: LOG_FILTER_MESSAGE_TYPE, filter }).catch(() => {});
    }
  }
}

/**
 * Get current log filter
 */
export function getLogFilter(): string {
  return globalThis.hwcLogFilter ?? '*';
}

export interface Logger {
  /** Always shown - important info */
  info: (...args: unknown[]) => void;
  /** Filtered - debug details */
  debug: (...args: unknown[]) => void;
  /** Always shown - warnings */
  warn: (...args: unknown[]) => void;
  /** Always shown - errors */
  error: (...args: unknown[]) => void;
  /** Performance logging - filtered */
  perf: (...args: unknown[]) => void;
  /** Trace-level detail - filtered */
  trace: (...args: unknown[]) => void;
}

/**
 * Create a logger with a specific prefix
 */
export function createLogger(prefix: string): Logger {
  const tag = `[${prefix}]`;

  return {
    info: (...args: unknown[]) => {
      if (shouldLog(prefix)) {
        console.log(tag, ...args);
      }
    },
    debug: (...args: unknown[]) => {
      if (shouldLog(prefix)) {
        console.log(tag, ...args);
      }
    },
    warn: (...args: unknown[]) => {
      // Warnings always shown
      console.warn(tag, ...args);
    },
    error: (...args: unknown[]) => {
      // Errors always shown
      console.error(tag, ...args);
    },
    perf: (...args: unknown[]) => {
      if (shouldLog(prefix) && shouldLog('PERF')) {
        console.log(`[PERF ${prefix}]`, ...args);
      }
    },
    trace: (...args: unknown[]) => {
      if (shouldLog(prefix) && shouldLog('TRACE')) {
        console.log(`[TRACE ${prefix}]`, ...args);
      }
    },
  };
}
