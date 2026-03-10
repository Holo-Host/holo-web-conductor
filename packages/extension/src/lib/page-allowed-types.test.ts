import { describe, it, expect } from "vitest";
import { PAGE_ALLOWED_TYPES } from "./page-allowed-types";
import { MessageType } from "./messaging";

describe("PAGE_ALLOWED_TYPES", () => {
  // These are the message types the inject SDK (inject/index.ts) actually sends.
  // If you add a new page-facing API, add it here AND to page-allowed-types.ts.
  const SDK_TYPES = [
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
  ];

  for (const type of SDK_TYPES) {
    it(`allows SDK type: ${type}`, () => {
      expect(PAGE_ALLOWED_TYPES.has(type)).toBe(true);
    });
  }

  // Lair management operations must NEVER be relayed from web pages
  const BLOCKED_LAIR_TYPES = [
    MessageType.LAIR_SIGN,
    MessageType.LAIR_NEW_SEED,
    MessageType.LAIR_DELETE_ENTRY,
    MessageType.LAIR_DERIVE_SEED,
    MessageType.LAIR_EXPORT_SEED,
    MessageType.LAIR_IMPORT_SEED,
    MessageType.LAIR_EXPORT_MNEMONIC,
    MessageType.LAIR_IMPORT_MNEMONIC,
    MessageType.LAIR_SET_PASSPHRASE,
    MessageType.LAIR_UNLOCK,
    MessageType.LAIR_LOCK,
    MessageType.LAIR_GET_LOCK_STATE,
    MessageType.LAIR_LIST_ENTRIES,
    MessageType.LAIR_GET_ENTRY,
    MessageType.LAIR_VERIFY,
  ];

  for (const type of BLOCKED_LAIR_TYPES) {
    it(`blocks Lair type: ${type}`, () => {
      expect(PAGE_ALLOWED_TYPES.has(type)).toBe(false);
    });
  }

  // Permission management operations must not be relayed from web pages
  const BLOCKED_PERMISSION_TYPES = [
    MessageType.PERMISSION_GRANT,
    MessageType.PERMISSION_DENY,
    MessageType.PERMISSION_LIST,
    MessageType.PERMISSION_REVOKE,
    MessageType.AUTH_REQUEST_INFO,
  ];

  for (const type of BLOCKED_PERMISSION_TYPES) {
    it(`blocks permission type: ${type}`, () => {
      expect(PAGE_ALLOWED_TYPES.has(type)).toBe(false);
    });
  }

  // Admin/debug operations must not be relayed from web pages
  const BLOCKED_ADMIN_TYPES = [
    MessageType.LIST_HAPPS,
    MessageType.UNINSTALL_HAPP,
    MessageType.ENABLE_HAPP,
    MessageType.DISABLE_HAPP,
    MessageType.PUBLISH_GET_STATUS,
    MessageType.PUBLISH_RETRY_FAILED,
    MessageType.PUBLISH_ALL_RECORDS,
    MessageType.RECOVER_CHAIN,
    MessageType.GET_RECOVERY_PROGRESS,
    MessageType.LINKER_DISCONNECT,
    MessageType.LINKER_RECONNECT,
  ];

  for (const type of BLOCKED_ADMIN_TYPES) {
    it(`blocks admin type: ${type}`, () => {
      expect(PAGE_ALLOWED_TYPES.has(type)).toBe(false);
    });
  }

  // Response/push types are not page-initiated requests
  const NON_REQUEST_TYPES = [
    MessageType.SUCCESS,
    MessageType.ERROR,
    MessageType.SIGNAL,
  ];

  for (const type of NON_REQUEST_TYPES) {
    it(`blocks non-request type: ${type}`, () => {
      expect(PAGE_ALLOWED_TYPES.has(type)).toBe(false);
    });
  }

  // Exhaustive check: every MessageType value must be either explicitly
  // allowed or explicitly blocked above. If a new MessageType is added
  // to the enum without updating this test, this test will fail —
  // forcing the developer to decide whether it should be page-accessible.
  //
  // Note: PAGE_ALLOWED_TYPES uses string literals (not enum references)
  // so that renaming an enum value is fail-safe — the allowlist silently
  // becomes more restrictive rather than accidentally allowing something.
  it("accounts for every MessageType enum value", () => {
    const allExplicitlyListed = new Set<string>([
      ...SDK_TYPES,
      ...BLOCKED_LAIR_TYPES,
      ...BLOCKED_PERMISSION_TYPES,
      ...BLOCKED_ADMIN_TYPES,
      ...NON_REQUEST_TYPES,
    ]);

    const allEnumValues = Object.values(MessageType) as string[];
    const unlisted = allEnumValues.filter((v) => !allExplicitlyListed.has(v));

    expect(unlisted).toEqual([]);
  });
});
