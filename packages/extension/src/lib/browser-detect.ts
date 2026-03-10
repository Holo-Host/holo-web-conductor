/**
 * Browser detection utilities for Chrome/Firefox compatibility.
 *
 * Uses feature detection rather than user-agent sniffing.
 * Firefox supports the `chrome.*` namespace in MV3, so we keep using it everywhere.
 */

/** True if the offscreen document API is available (Chrome only). */
export function hasOffscreenSupport(): boolean {
  return typeof chrome !== "undefined" && typeof chrome.offscreen !== "undefined";
}

/** True if SharedArrayBuffer is available in this context. */
export function hasSharedArrayBufferSupport(): boolean {
  try {
    new SharedArrayBuffer(1);
    return true;
  } catch {
    return false;
  }
}

/** True if running in Firefox (no offscreen API). */
export function isFirefox(): boolean {
  return !hasOffscreenSupport();
}
