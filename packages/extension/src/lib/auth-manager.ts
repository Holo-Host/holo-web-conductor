/**
 * Authorization request manager for Holochain extension
 *
 * Manages pending authorization requests while waiting for user approval/denial.
 * Handles request lifecycle, timeouts, and promise resolution.
 */

import type { ResponseMessage } from "./messaging";

/**
 * Pending authorization request
 */
export interface PendingAuthRequest {
  id: string;               // Unique request ID
  origin: string;           // Requesting origin
  tabId: number;            // Tab ID for response
  messageId: string;        // Original message ID to respond to
  timestamp: number;        // When request was made
  timeoutHandle: number;    // Timeout handle for cleanup
}

/**
 * Callback for resolving pending requests
 */
type ResolveCallback = (response: ResponseMessage) => void;

/**
 * Authorization manager for pending requests
 */
export class AuthManager {
  private pendingRequests: Map<string, PendingAuthRequest> = new Map();
  private resolveCallbacks: Map<string, ResolveCallback> = new Map();
  private static readonly REQUEST_TIMEOUT_MS = 120000; // 2 minutes

  /**
   * Create a new authorization request
   */
  async createAuthRequest(
    origin: string,
    tabId: number,
    messageId: string
  ): Promise<PendingAuthRequest> {
    const id = this.generateRequestId();

    // Create timeout to cleanup abandoned requests
    const timeoutHandle = setTimeout(() => {
      this.timeoutAuthRequest(id);
    }, AuthManager.REQUEST_TIMEOUT_MS) as unknown as number;

    const request: PendingAuthRequest = {
      id,
      origin,
      tabId,
      messageId,
      timestamp: Date.now(),
      timeoutHandle,
    };

    this.pendingRequests.set(id, request);
    console.log(`[AuthManager] Created auth request ${id} for ${origin}`);

    return request;
  }

  /**
   * Get authorization request info by ID
   */
  async getAuthRequest(requestId: string): Promise<PendingAuthRequest | undefined> {
    return this.pendingRequests.get(requestId);
  }

  /**
   * Set callback for pending request resolution
   */
  setPendingCallback(requestId: string, callback: ResolveCallback): void {
    this.resolveCallbacks.set(requestId, callback);
  }

  /**
   * Resolve an authorization request with a response
   */
  async resolveAuthRequest(
    requestId: string,
    response: ResponseMessage
  ): Promise<boolean> {
    const request = this.pendingRequests.get(requestId);
    if (!request) {
      console.warn(`[AuthManager] Cannot resolve unknown request ${requestId}`);
      return false;
    }

    // Clear timeout
    clearTimeout(request.timeoutHandle);

    // Get and call resolve callback
    const callback = this.resolveCallbacks.get(requestId);
    if (callback) {
      callback(response);
      this.resolveCallbacks.delete(requestId);
    }

    // Cleanup
    this.pendingRequests.delete(requestId);

    console.log(`[AuthManager] Resolved auth request ${requestId}`);
    return true;
  }

  /**
   * Timeout an authorization request
   */
  private timeoutAuthRequest(requestId: string): void {
    const request = this.pendingRequests.get(requestId);
    if (!request) {
      return;
    }

    console.warn(
      `[AuthManager] Auth request ${requestId} timed out after ${
        AuthManager.REQUEST_TIMEOUT_MS / 1000
      } seconds`
    );

    // Resolve with timeout error
    const callback = this.resolveCallbacks.get(requestId);
    if (callback) {
      // Create timeout error response
      const timeoutResponse: ResponseMessage = {
        id: requestId,
        type: "error" as any, // MessageType.ERROR
        timestamp: Date.now(),
        requestId: request.messageId,
        error: "Authorization request timed out. Please try again.",
      };
      callback(timeoutResponse);
      this.resolveCallbacks.delete(requestId);
    }

    // Cleanup
    this.pendingRequests.delete(requestId);
  }

  /**
   * Cleanup expired requests
   */
  cleanupExpired(): void {
    const now = Date.now();
    const expiredRequests: string[] = [];

    for (const [id, request] of this.pendingRequests.entries()) {
      if (now - request.timestamp > AuthManager.REQUEST_TIMEOUT_MS) {
        expiredRequests.push(id);
      }
    }

    for (const id of expiredRequests) {
      this.timeoutAuthRequest(id);
    }

    if (expiredRequests.length > 0) {
      console.log(`[AuthManager] Cleaned up ${expiredRequests.length} expired requests`);
    }
  }

  /**
   * Get count of pending requests
   */
  getPendingCount(): number {
    return this.pendingRequests.size;
  }

  /**
   * Generate unique request ID
   */
  private generateRequestId(): string {
    return `auth-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }
}

/**
 * Singleton instance
 */
let authManagerInstance: AuthManager | null = null;

/**
 * Get the singleton AuthManager instance
 */
export function getAuthManager(): AuthManager {
  if (!authManagerInstance) {
    authManagerInstance = new AuthManager();
  }
  return authManagerInstance;
}
