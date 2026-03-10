import { createErrorResponse, type ResponseMessage } from "./messaging";

/**
 * Check if a message sender is from a web page tab (content script context).
 * Returns an error response if so, null if the sender is trusted (popup/extension).
 *
 * Use this as a guard at the top of handlers that should only be invoked
 * from the popup UI, never from web pages.
 */
export function rejectTabSender(
  sender: chrome.runtime.MessageSender,
  messageId: string,
  operation: string
): ResponseMessage | null {
  if (sender.tab) {
    return createErrorResponse(
      messageId,
      `${operation} is not allowed from web pages`
    );
  }
  return null;
}

/**
 * Check if the sender is from a tab context (content script relay).
 */
export function isTabSender(
  sender: chrome.runtime.MessageSender
): boolean {
  return !!sender.tab;
}

/**
 * Extract the origin from a tab sender's URL.
 * Returns null if the sender has no tab or no URL.
 */
export function getOriginFromSender(
  sender: chrome.runtime.MessageSender
): string | null {
  if (!sender.tab?.url) return null;
  try {
    return new URL(sender.tab.url).origin;
  } catch {
    return null;
  }
}
