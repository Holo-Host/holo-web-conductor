import { describe, it, expect } from "vitest";
import { rejectTabSender, isTabSender, getOriginFromSender } from "./sender-validation";
import { MessageType } from "./messaging";

describe("rejectTabSender", () => {
  it("blocks requests from a tab context (content script)", () => {
    const sender = {
      tab: { id: 1, url: "https://evil.example.com/page" },
    } as chrome.runtime.MessageSender;

    const result = rejectTabSender(sender, "msg-1", "LAIR_EXPORT_MNEMONIC");

    expect(result).not.toBeNull();
    expect(result!.type).toBe(MessageType.ERROR);
    expect(result!.error).toContain("not allowed from web pages");
    expect(result!.error).toContain("LAIR_EXPORT_MNEMONIC");
  });

  it("allows requests from popup context (no tab)", () => {
    const sender = {} as chrome.runtime.MessageSender;

    const result = rejectTabSender(sender, "msg-2", "LAIR_EXPORT_MNEMONIC");

    expect(result).toBeNull();
  });

  it("allows requests from extension page (url but no tab)", () => {
    const sender = {
      url: "chrome-extension://abc123/popup.html",
    } as chrome.runtime.MessageSender;

    const result = rejectTabSender(sender, "msg-3", "LAIR_NEW_SEED");

    expect(result).toBeNull();
  });

  it("includes the operation name in the error message", () => {
    const sender = {
      tab: { id: 42, url: "https://attacker.com" },
    } as chrome.runtime.MessageSender;

    const result = rejectTabSender(sender, "msg-4", "LAIR_DELETE_ENTRY");

    expect(result).not.toBeNull();
    expect(result!.error).toContain("LAIR_DELETE_ENTRY");
  });
});

describe("isTabSender", () => {
  it("returns true for tab senders", () => {
    const sender = {
      tab: { id: 1, url: "https://example.com" },
    } as chrome.runtime.MessageSender;

    expect(isTabSender(sender)).toBe(true);
  });

  it("returns false for popup senders", () => {
    const sender = {} as chrome.runtime.MessageSender;

    expect(isTabSender(sender)).toBe(false);
  });

  it("returns false for extension page senders", () => {
    const sender = {
      url: "chrome-extension://abc/popup.html",
    } as chrome.runtime.MessageSender;

    expect(isTabSender(sender)).toBe(false);
  });
});

describe("getOriginFromSender", () => {
  it("extracts origin from tab URL", () => {
    const sender = {
      tab: { id: 1, url: "https://example.com/path?query=1" },
    } as chrome.runtime.MessageSender;

    expect(getOriginFromSender(sender)).toBe("https://example.com");
  });

  it("returns null for sender without tab", () => {
    const sender = {} as chrome.runtime.MessageSender;

    expect(getOriginFromSender(sender)).toBeNull();
  });

  it("returns null for tab without URL", () => {
    const sender = {
      tab: { id: 1 },
    } as chrome.runtime.MessageSender;

    expect(getOriginFromSender(sender)).toBeNull();
  });

  it("returns null for invalid URL", () => {
    const sender = {
      tab: { id: 1, url: "not-a-valid-url" },
    } as chrome.runtime.MessageSender;

    expect(getOriginFromSender(sender)).toBeNull();
  });
});
