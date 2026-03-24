/**
 * Centralized logging utility with filterable prefixes
 *
 * Log levels:
 *   error, warn  - Always shown
 *   info         - Always shown (lifecycle milestones, state changes)
 *   debug        - Filtered by prefix (component-level operational detail)
 *   trace        - Filtered by prefix + TRACE keyword
 *   perf         - Filtered by prefix + PERF keyword
 *
 * Usage:
 *   import { createLogger, setLogFilter } from '@hwc/shared';
 *   const log = createLogger('Background');
 *   log.info('connected');   // Always shown: [Background] connected
 *   log.debug('details');    // Only if filter includes 'Background'
 *
 * Runtime filter control (in any extension console):
 *   setHwcLogFilter('Background,Offscreen'); // Show debug logs for these prefixes
 *   setHwcLogFilter('*');                    // All debug logs
 *   setHwcLogFilter('*,PERF');               // All debug + performance metrics
 *   setHwcLogFilter('*,TRACE');              // All debug + trace detail
 *   setHwcLogFilter('');                     // Quiet: errors, warnings, info only (default)
 *
 * Filter syncs across all contexts (background, offscreen, worker) via chrome.runtime messaging
 */

// Global filter - comma-separated list of prefixes to show, '*' for all, '' for none
declare global {
  interface Window {
    hwcLogFilter?: string;
  }
  var hwcLogFilter: string | undefined;
}

// Minimal chrome API type for use in shared package (which cannot depend on @types/chrome).
// Extension code gets full types from @types/chrome; this only covers what logger.ts needs.
interface ChromeForLogger {
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
}

function getChromeApi(): ChromeForLogger | undefined {
  if (typeof globalThis !== 'undefined' && 'chrome' in globalThis) {
    return (globalThis as Record<string, unknown>).chrome as ChromeForLogger;
  }
  return undefined;
}

// Message type for log filter changes
const LOG_FILTER_MESSAGE_TYPE = 'HWC_LOG_FILTER_CHANGE';

// Initialize filter on globalThis if not set
if (typeof globalThis !== 'undefined' && globalThis.hwcLogFilter === undefined) {
  globalThis.hwcLogFilter = ''; // Default: quiet (errors/warnings/info only)
}

// Load filter from storage on init (for persistence across restarts)
// Only in extension contexts where chrome.storage is available
{
  const chromeApi = getChromeApi();
  if (chromeApi?.storage?.local) {
    chromeApi.storage.local.get(['hwcLogFilter']).then((result: Record<string, unknown>) => {
      if (typeof result.hwcLogFilter === 'string') {
        globalThis.hwcLogFilter = result.hwcLogFilter;
      }
    }).catch(() => {});
  }

  // Listen for filter changes from other contexts via runtime messaging
  if (chromeApi?.runtime?.onMessage) {
    chromeApi.runtime.onMessage.addListener((message: unknown) => {
      if (message && typeof message === 'object' && 'type' in message && 'filter' in message) {
        const msg = message as { type: string; filter: string };
        if (msg.type === LOG_FILTER_MESSAGE_TYPE) {
          globalThis.hwcLogFilter = msg.filter;
        }
      }
    });
  }
}

/**
 * Check if a prefix should be logged based on the current filter
 */
function shouldLog(prefix: string): boolean {
  const filter = globalThis.hwcLogFilter ?? '';
  if (filter === '') return false;

  const allowedPrefixes = filter.split(',').map(p => p.trim().toLowerCase());

  // '*' anywhere in the list means match all prefixes
  if (allowedPrefixes.includes('*')) return true;

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

  const chromeApi = getChromeApi();
  if (chromeApi) {
    // Persist to storage for persistence across restarts
    if (chromeApi.storage?.local) {
      chromeApi.storage.local.set({ hwcLogFilter: filter }).catch(() => {});
    }

    // Broadcast to all extension contexts via runtime messaging
    if (chromeApi.runtime?.sendMessage) {
      chromeApi.runtime.sendMessage({ type: LOG_FILTER_MESSAGE_TYPE, filter }).catch(() => {});
    }
  }
}

/**
 * Get current log filter
 */
export function getLogFilter(): string {
  return globalThis.hwcLogFilter ?? '';
}

export interface Logger {
  /** Always shown - lifecycle milestones, state changes */
  info: (...args: unknown[]) => void;
  /** Filtered by prefix - component-level operational detail */
  debug: (...args: unknown[]) => void;
  /** Always shown - warnings */
  warn: (...args: unknown[]) => void;
  /** Always shown - errors */
  error: (...args: unknown[]) => void;
  /** Filtered by prefix + PERF - performance metrics */
  perf: (...args: unknown[]) => void;
  /** Filtered by prefix + TRACE - per-call data dumps */
  trace: (...args: unknown[]) => void;
}

/**
 * Create a logger with a specific prefix
 */
export function createLogger(prefix: string): Logger {
  const tag = `[${prefix}]`;

  return {
    info: (...args: unknown[]) => {
      // Info always shown - use for lifecycle milestones and state changes
      console.log(tag, ...args);
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
