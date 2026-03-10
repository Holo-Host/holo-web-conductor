/**
 * Message types that web pages are allowed to send through the content script.
 * This is the security boundary between untrusted page code and the extension.
 *
 * SECURITY: Only add types here that the inject SDK (inject/index.ts) needs to send.
 * Lair management, permission, and admin operations must NEVER appear here.
 *
 * String literals are used intentionally (not MessageType enum references) so that
 * renaming an enum value is fail-safe: the allowlist silently becomes more restrictive
 * rather than accidentally allowing a renamed operation. The exhaustive enum test in
 * page-allowed-types.test.ts catches any new types that need explicit categorization.
 */
export const PAGE_ALLOWED_TYPES = new Set<string>([
  "connect",
  "disconnect",
  "app_info",
  "call_zome",
  "install_happ",
  "provide_memproofs",
  "linker_configure",
  "linker_get_status",
  "connection_status_get",
  "connection_status_subscribe",
  "connection_status_unsubscribe",
  "sign_reconnect_challenge",
  "sign_joining_nonce",
]);
