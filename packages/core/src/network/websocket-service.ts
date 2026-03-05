/**
 * WebSocket Network Service
 *
 * Manages a WebSocket connection to the linker for receiving remote signals.
 * This service is designed to run in the offscreen document where persistent
 * connections are supported.
 *
 * Protocol (see h2hc-linker linker):
 * - Browser → Linker: auth, auth_challenge_response, register, unregister, ping
 * - Linker → Browser: auth_ok, auth_challenge, auth_error, registered, unregistered, signal, pong, error
 */

import { decodeHashFromBase64 } from "../types/holochain-types";
import { createLogger } from "@hwc/shared";
import {
  AgentInfoFields,
  validateAgentInfo,
  serializeAgentInfoCanonical,
} from "./agent-info-validator";

const log = createLogger('WebSocket');

/**
 * Messages from browser to linker
 */
/**
 * Signed remote signal for transport to linker
 */
export interface SignedRemoteSignalTransport {
  /** Target agent public key (as array for JSON transport) */
  target_agent: number[];
  /** Serialized ZomeCallParams (as array for JSON transport) */
  zome_call_params: number[];
  /** Ed25519 signature (64 bytes, as array for JSON transport) */
  signature: number[];
}

export type ClientMessage =
  | { type: "auth"; agent_pubkey: string }
  | { type: "auth_challenge_response"; signature: string }
  | { type: "register"; dna_hash: string; agent_pubkey: string }
  | { type: "unregister"; dna_hash: string; agent_pubkey: string }
  | { type: "ping" }
  | {
      type: "sign_response";
      request_id: string;
      signature?: string; // base64-encoded signature
      error?: string;
    }
  | {
      type: "send_remote_signal";
      dna_hash: string; // base64-encoded DnaHash
      signals: SignedRemoteSignalTransport[];
    };

/**
 * Messages from linker to browser
 */
export type ServerMessage =
  | { type: "auth_ok"; session_token?: string }
  | { type: "auth_challenge"; challenge: string }
  | { type: "auth_error"; message: string }
  | { type: "registered"; dna_hash: string; agent_pubkey: string }
  | { type: "unregistered"; dna_hash: string; agent_pubkey: string }
  | {
      type: "signal";
      dna_hash: string;
      to_agent: string; // Target agent this signal is addressed to
      from_agent: string;
      zome_name: string;
      signal: string; // base64-encoded signal payload
    }
  | { type: "pong" }
  | { type: "error"; message: string }
  | {
      type: "sign_agent_info";
      request_id: string;
      agent_pubkey: string; // HoloHash base64-encoded agent public key
      agent_info: AgentInfoFields; // structured agent info for validation
    };

/**
 * Connection state
 */
export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "authenticating"
  | "connected"
  | "reconnecting";

/**
 * Signal callback - called when a signal is received from the linker
 */
export type SignalCallback = (signal: {
  dna_hash: string;
  to_agent: string; // Target agent this signal is addressed to
  from_agent: string;
  zome_name: string;
  signal: Uint8Array; // decoded from base64
}) => void;

/**
 * Connection state callback
 */
export type StateCallback = (state: ConnectionState) => void;

/**
 * Sign callback - called when the linker requests a signature.
 * Receives the agent public key and the bytes to sign (constructed locally
 * from validated agent info, not raw bytes from the linker).
 */
export type SignCallback = (request: {
  agent_pubkey: Uint8Array; // decoded from base64
  message: Uint8Array; // canonical JSON bytes constructed locally
}) => Promise<Uint8Array>;

/**
 * Options for WebSocket network service
 */
export interface WebSocketServiceOptions {
  /** Linker WebSocket URL (e.g., "ws://localhost:8090/ws") */
  linkerWsUrl: string;
  /** Session token for authentication (from /auth/verify flow) */
  sessionToken?: string;
  /** Heartbeat interval in ms (default: 30000) */
  heartbeatInterval?: number;
  /** Heartbeat timeout in ms (default: 5000) */
  heartbeatTimeout?: number;
  /** Reconnect base delay in ms (default: 1000) */
  reconnectBaseDelay?: number;
  /** Maximum reconnect delay in ms (default: 30000) */
  reconnectMaxDelay?: number;
  /** Maximum reconnect attempts (default: Infinity) */
  maxReconnectAttempts?: number;
}

/**
 * Agent registration info
 */
interface AgentRegistration {
  dna_hash: string;
  agent_pubkey: string;
}

/**
 * WebSocket Network Service
 *
 * Manages connection to linker for remote signal delivery.
 */
export class WebSocketNetworkService {
  private ws: WebSocket | null = null;
  private options: Required<WebSocketServiceOptions>;
  private state: ConnectionState = "disconnected";
  private registrations: AgentRegistration[] = [];
  private pendingRegistrations: AgentRegistration[] = [];
  private signalCallback: SignalCallback | null = null;
  private stateCallback: StateCallback | null = null;
  private signCallback: SignCallback | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private authenticated = false;
  private intentionalClose = false;
  /** Agent pubkey we're currently authenticating with (mirrors linker's pending_auth_agent) */
  private pendingAuthAgent: string | null = null;
  /** Agent pubkeys that failed auth (so we can try the next one) */
  private failedAuthAgents = new Set<string>();
  private sessionTokenCallback: ((token: string) => void) | null = null;

  constructor(options: WebSocketServiceOptions) {
    this.options = {
      linkerWsUrl: options.linkerWsUrl,
      sessionToken: options.sessionToken || "",
      heartbeatInterval: options.heartbeatInterval ?? 30000,
      heartbeatTimeout: options.heartbeatTimeout ?? 5000,
      reconnectBaseDelay: options.reconnectBaseDelay ?? 1000,
      reconnectMaxDelay: options.reconnectMaxDelay ?? 30000,
      maxReconnectAttempts: options.maxReconnectAttempts ?? Infinity,
    };
  }

  /**
   * Get current connection state
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Check if connected and authenticated
   */
  isConnected(): boolean {
    return this.state === "connected" && this.authenticated;
  }

  /**
   * Check if authenticated with the linker
   */
  isAuthenticated(): boolean {
    return this.authenticated;
  }

  /**
   * Set signal callback
   */
  onSignal(callback: SignalCallback): void {
    this.signalCallback = callback;
  }

  /**
   * Set state change callback
   */
  onStateChange(callback: StateCallback): void {
    this.stateCallback = callback;
  }

  /**
   * Set sign callback - called when the linker requests a signature
   *
   * The callback receives the agent public key and message bytes,
   * and should return the signature bytes.
   */
  onSign(callback: SignCallback): void {
    this.signCallback = callback;
  }

  /**
   * Update session token (kept for backward compatibility).
   * Auth is now agent-pubkey-based via WebSocket protocol.
   */
  setSessionToken(token: string | null): void {
    this.options.sessionToken = token || "";
  }

  /**
   * Set callback for when a session token is received from auth_ok.
   * The offscreen document uses this to update HTTP Bearer auth.
   */
  onSessionToken(callback: (token: string) => void): void {
    this.sessionTokenCallback = callback;
  }

  /**
   * Connect to the linker WebSocket
   */
  getUrl(): string {
    return this.options.linkerWsUrl;
  }

  connect(): void {
    if (this.ws) {
      log.debug("Already connected or connecting");
      return;
    }

    this.intentionalClose = false;
    this.setState("connecting");

    console.log(`[WebSocketService] Connecting to ${this.options.linkerWsUrl}`);

    try {
      this.ws = new WebSocket(this.options.linkerWsUrl);

      this.ws.onopen = () => {
        console.log("[WebSocketService] WS onopen fired");
        this.handleOpen();
      };
      this.ws.onmessage = (event) => this.handleMessage(event);
      this.ws.onerror = (event) => {
        console.error("[WebSocketService] WS onerror:", event);
        this.handleError(event);
      };
      this.ws.onclose = (event) => {
        console.log(`[WebSocketService] WS onclose: code=${event.code} reason=${event.reason} wasClean=${event.wasClean}`);
        this.handleClose(event);
      };
    } catch (error) {
      console.error("[WebSocketService] Connection failed:", error);
      this.scheduleReconnect();
    }
  }

  /**
   * Disconnect from the linker
   */
  disconnect(): void {
    log.debug("Disconnecting");
    this.intentionalClose = true;
    this.cleanup();
    this.setState("disconnected");
  }

  /**
   * Register an agent to receive signals for a DNA
   */
  registerAgent(dna_hash: string, agent_pubkey: string): void {
    const registration = { dna_hash, agent_pubkey };

    // Check if already in our local tracking
    const alreadyTracked = this.registrations.some(
      (r) => r.dna_hash === dna_hash && r.agent_pubkey === agent_pubkey
    ) || this.pendingRegistrations.some(
      (r) => r.dna_hash === dna_hash && r.agent_pubkey === agent_pubkey
    );

    if (this.isConnected()) {
      // Always send registration when connected - linker may have lost it
      // (e.g., linker restarted while we stayed connected)
      log.debug(`Sending registration: ${agent_pubkey.substring(0, 20)}... for ${dna_hash.substring(0, 20)}...`);
      this.send({ type: "register", dna_hash, agent_pubkey });
      if (!alreadyTracked) {
        this.registrations.push(registration);
      }
    } else {
      // Queue for when connected (only if not already tracked)
      if (!alreadyTracked) {
        this.pendingRegistrations.push(registration);
      }
      // If WS is open but not authenticated, trigger auth with this agent
      if (this.ws?.readyState === WebSocket.OPEN && !this.authenticated && this.state !== "authenticating") {
        this.authenticate(agent_pubkey);
      }
    }
  }

  /**
   * Unregister an agent from receiving signals for a DNA
   */
  unregisterAgent(dna_hash: string, agent_pubkey: string): void {
    // Remove from registrations
    this.registrations = this.registrations.filter(
      (r) => !(r.dna_hash === dna_hash && r.agent_pubkey === agent_pubkey)
    );

    // Remove from pending
    this.pendingRegistrations = this.pendingRegistrations.filter(
      (r) => !(r.dna_hash === dna_hash && r.agent_pubkey === agent_pubkey)
    );

    if (this.isConnected()) {
      this.send({ type: "unregister", dna_hash, agent_pubkey });
    }
  }

  /**
   * Get list of registered agents
   */
  getRegistrations(): AgentRegistration[] {
    return [...this.registrations];
  }

  /**
   * Send remote signals to target agents via the linker
   *
   * Fire-and-forget: signals are queued for delivery but success is not confirmed.
   */
  sendRemoteSignals(dna_hash: string, signals: SignedRemoteSignalTransport[]): void {
    if (signals.length === 0) {
      return;
    }

    if (this.isConnected()) {
      log.debug(` Sending ${signals.length} remote signals for DNA ${dna_hash.slice(0, 12)}...`);
      this.send({ type: "send_remote_signal", dna_hash, signals });
    } else {
      console.warn(`[WebSocketService] Cannot send remote signals - not connected`);
    }
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private prevAuthenticated = false;

  private setState(state: ConnectionState): void {
    const authChanged = this.authenticated !== this.prevAuthenticated;
    if (this.state !== state || authChanged) {
      log.debug(` State: ${this.state} -> ${state} (authenticated: ${this.authenticated})`);
      this.state = state;
      this.prevAuthenticated = this.authenticated;
      this.stateCallback?.(state);
    }
  }

  private handleOpen(): void {
    log.debug("Connected");
    this.reconnectAttempts = 0;
    this.failedAuthAgents.clear();
    this.startHeartbeat();

    // Authenticate with the first untried agent from pending registrations.
    // Otherwise, wait for registerAgent() to trigger auth.
    this.tryAuthenticateNextAgent();
  }

  /**
   * Try to authenticate with the next untried agent from pending registrations.
   * Skips agents that have already failed auth on this connection.
   */
  private tryAuthenticateNextAgent(): void {
    // Collect unique agent pubkeys from both pending and confirmed registrations
    const allAgents = [
      ...this.pendingRegistrations.map(r => r.agent_pubkey),
      ...this.registrations.map(r => r.agent_pubkey),
    ];
    const uniqueAgents = [...new Set(allAgents)];
    const nextAgent = uniqueAgents.find(a => !this.failedAuthAgents.has(a));

    if (nextAgent) {
      this.authenticate(nextAgent);
    } else if (uniqueAgents.length > 0) {
      console.warn("[WebSocketService] All agents failed auth, no more agents to try");
    }
  }

  private handleMessage(event: MessageEvent): void {
    try {
      const message = JSON.parse(event.data) as ServerMessage;
      log.debug("Received:", message.type);

      switch (message.type) {
        case "auth_ok":
          this.handleAuthOk(message);
          break;

        case "auth_challenge":
          this.handleAuthChallenge(message).catch((e) =>
            console.error("[WebSocketService] Auth challenge handling failed:", e)
          );
          break;

        case "auth_error":
          this.handleAuthError(message.message);
          break;

        case "registered":
          log.debug(`Agent registered: ${message.agent_pubkey} for ${message.dna_hash}`);
          break;

        case "unregistered":
          log.debug(`Agent unregistered: ${message.agent_pubkey} for ${message.dna_hash}`);
          break;

        case "signal":
          this.handleSignal(message);
          break;

        case "pong":
          this.handlePong();
          break;

        case "error":
          console.error("[WebSocketService] Server error:", message.message);
          break;

        case "sign_agent_info":
          this.handleSignAgentInfo(message);
          break;
      }
    } catch (error) {
      console.error("[WebSocketService] Failed to parse message:", error);
    }
  }

  private handleError(event: Event): void {
    console.error("[WebSocketService] WebSocket error:", event);
  }

  private handleClose(event: CloseEvent): void {
    log.debug(`Connection closed: code=${event.code}, reason=${event.reason}`);
    this.cleanup();

    // Move registrations back to pending so they get re-sent on reconnect
    // This is needed because the linker forgets registrations when connection drops
    if (this.registrations.length > 0) {
      log.debug(`Moving ${this.registrations.length} registrations to pending for re-send`);
      this.pendingRegistrations.push(...this.registrations);
      this.registrations = [];
    }

    if (!this.intentionalClose) {
      this.scheduleReconnect();
    } else {
      this.setState("disconnected");
    }
  }

  private authenticate(agentPubkey: string): void {
    console.log(`[WebSocketService] Authenticating with agent: ${agentPubkey.substring(0, 20)}...`);
    this.pendingAuthAgent = agentPubkey;
    this.setState("authenticating");
    this.send({ type: "auth", agent_pubkey: agentPubkey });
  }

  private handleAuthOk(message: Extract<ServerMessage, { type: "auth_ok" }>): void {
    console.log("[WebSocketService] handleAuthOk - full message:", JSON.stringify(message));
    console.log("[WebSocketService] handleAuthOk - session_token present:", !!message.session_token, "value:", message.session_token?.substring(0, 30));
    log.debug("Authenticated");
    this.authenticated = true;
    this.pendingAuthAgent = null;

    // Capture session token for HTTP auth
    if (message.session_token) {
      this.options.sessionToken = message.session_token;
      console.log("[WebSocketService] Calling sessionTokenCallback, callback exists:", !!this.sessionTokenCallback);
      this.sessionTokenCallback?.(message.session_token);
    } else {
      console.warn("[WebSocketService] auth_ok has NO session_token - HTTP auth will fail");
    }

    this.setState("connected");

    // Register pending agents
    this.processPendingRegistrations();
  }

  private handleAuthError(message: string): void {
    console.error("[WebSocketService] Authentication failed:", message);
    this.authenticated = false;

    // Track the failed agent and try the next one
    if (this.pendingAuthAgent) {
      this.failedAuthAgents.add(this.pendingAuthAgent);
      console.log(`[WebSocketService] Agent ${this.pendingAuthAgent.substring(0, 20)}... failed auth, trying next`);
      this.pendingAuthAgent = null;
      this.tryAuthenticateNextAgent();
      // If tryAuthenticateNextAgent started a new auth attempt, don't change state
      if (this.pendingAuthAgent) return;
    }

    this.setState("connected");
  }

  private async handleAuthChallenge(message: Extract<ServerMessage, { type: "auth_challenge" }>): Promise<void> {
    console.log("[WebSocketService] Received auth challenge, pendingAuthAgent:", this.pendingAuthAgent?.substring(0, 20));

    if (!this.pendingAuthAgent) {
      console.error("[WebSocketService] Received auth challenge but no pending auth agent");
      return;
    }

    if (!this.signCallback) {
      console.error("[WebSocketService] Received auth challenge but no sign callback configured");
      this.send({ type: "auth_challenge_response", signature: "" });
      return;
    }

    try {
      // Decode agent pubkey from HoloHash base64 to raw bytes
      const agentBytes = decodeHashFromBase64(this.pendingAuthAgent);

      // Decode hex-encoded challenge nonce to bytes
      const challengeHex = message.challenge;
      const challengeBytes = new Uint8Array(
        challengeHex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16))
      );

      // Sign using the Lair sign callback
      const signature = await this.signCallback({
        agent_pubkey: agentBytes,
        message: challengeBytes,
      });

      // Send base64-encoded signature back
      const signatureB64 = btoa(String.fromCharCode(...signature));
      this.send({ type: "auth_challenge_response", signature: signatureB64 });
    } catch (error) {
      console.error("[WebSocketService] Failed to sign auth challenge:", error);
      this.send({ type: "auth_challenge_response", signature: "" });
    }
  }

  private handleSignal(message: Extract<ServerMessage, { type: "signal" }>): void {
    log.debug(`Signal for ${message.to_agent} from ${message.from_agent} (${message.zome_name})`);

    if (this.signalCallback) {
      try {
        // Decode base64 signal payload
        const signalBytes = Uint8Array.from(atob(message.signal), (c) =>
          c.charCodeAt(0)
        );

        this.signalCallback({
          dna_hash: message.dna_hash,
          to_agent: message.to_agent,
          from_agent: message.from_agent,
          zome_name: message.zome_name,
          signal: signalBytes,
        });
      } catch (error) {
        console.error("[WebSocketService] Failed to process signal:", error);
      }
    }
  }

  private handlePong(): void {
    // Clear the timeout - server is alive
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }

  /**
   * Handle sign_agent_info: transparent signing protocol.
   *
   * Validates the structured agent info fields, constructs the canonical
   * JSON locally, and signs that. The extension never signs opaque data
   * from the linker.
   */
  private handleSignAgentInfo(
    message: Extract<ServerMessage, { type: "sign_agent_info" }>
  ): void {
    log.debug(`Sign agent info request ${message.request_id} for agent ${message.agent_pubkey.substring(0, 20)}...`);

    if (!this.signCallback) {
      console.error("[WebSocketService] No sign callback registered");
      this.send({
        type: "sign_response",
        request_id: message.request_id,
        error: "No sign callback registered",
      });
      return;
    }

    // Build set of registered spaces for this agent (base64url-no-pad encoded)
    // Currently not available in a directly usable form, so pass undefined
    // to skip space validation. The agent_pubkey check is the critical one.
    const registeredSpaces: Set<string> | undefined = undefined;

    // Validate the agent info fields
    const validation = validateAgentInfo(
      message.agent_info,
      message.agent_pubkey,
      registeredSpaces,
    );

    if (!validation.valid) {
      console.error(`[WebSocketService] Agent info validation failed: ${validation.error}`);
      this.send({
        type: "sign_response",
        request_id: message.request_id,
        error: `Agent info validation failed: ${validation.error}`,
      });
      return;
    }

    // Construct canonical JSON locally from the validated fields
    const canonicalJson = serializeAgentInfoCanonical(message.agent_info);
    const messageBytes = new TextEncoder().encode(canonicalJson);

    // Decode agent pubkey
    let agentPubkey: Uint8Array;
    try {
      agentPubkey = decodeHashFromBase64(message.agent_pubkey);
    } catch (error) {
      console.error("[WebSocketService] Failed to decode agent_pubkey:", error);
      this.send({
        type: "sign_response",
        request_id: message.request_id,
        error: `Failed to decode agent_pubkey: ${error}`,
      });
      return;
    }

    // Sign the locally-constructed canonical JSON bytes
    this.signCallback({
      agent_pubkey: agentPubkey,
      message: messageBytes,
    })
      .then((signature) => {
        // Encode signature as base64
        const signatureB64 = btoa(
          String.fromCharCode.apply(null, Array.from(signature))
        );
        log.debug(`Sending sign response for ${message.request_id}`);
        this.send({
          type: "sign_response",
          request_id: message.request_id,
          signature: signatureB64,
        });
      })
      .catch((error) => {
        console.error("[WebSocketService] Signing failed:", error);
        this.send({
          type: "sign_response",
          request_id: message.request_id,
          error: `Signing failed: ${error}`,
        });
      });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();

    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send({ type: "ping" });

        // Set timeout for pong response
        this.heartbeatTimeoutTimer = setTimeout(() => {
          console.warn(
            "[WebSocketService] Heartbeat timeout, closing connection"
          );
          this.ws?.close();
        }, this.options.heartbeatTimeout);
      }
    }, this.options.heartbeatInterval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return; // Already scheduled
    }

    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      log.debug("Max reconnect attempts reached");
      this.setState("disconnected");
      return;
    }

    // Exponential backoff with jitter
    const delay = Math.min(
      this.options.reconnectBaseDelay * Math.pow(2, this.reconnectAttempts),
      this.options.reconnectMaxDelay
    );
    const jitter = delay * 0.2 * Math.random();
    const totalDelay = delay + jitter;

    log.debug(`Reconnecting in ${Math.round(totalDelay)}ms (attempt ${this.reconnectAttempts + 1})`);

    this.setState("reconnecting");
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ws = null;
      this.connect();
    }, totalDelay);
  }

  private processPendingRegistrations(): void {
    if (this.pendingRegistrations.length > 0) {
      log.debug(` Processing ${this.pendingRegistrations.length} pending registrations`);
    }
    for (const registration of this.pendingRegistrations) {
      log.debug(` Sending registration: ${registration.agent_pubkey.substring(0, 20)}... for ${registration.dna_hash.substring(0, 20)}...`);
      this.send({
        type: "register",
        dna_hash: registration.dna_hash,
        agent_pubkey: registration.agent_pubkey,
      });
      this.registrations.push(registration);
    }
    this.pendingRegistrations = [];
  }

  private send(message: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      console.warn("[WebSocketService] Cannot send - WebSocket not open");
    }
  }

  private cleanup(): void {
    this.stopHeartbeat();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;

      if (
        this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING
      ) {
        this.ws.close();
      }
      this.ws = null;
    }

    this.authenticated = false;
    this.failedAuthAgents.clear();
  }
}

// Singleton instance for the extension
let wsServiceInstance: WebSocketNetworkService | null = null;

/**
 * Get the global WebSocket service instance
 */
export function getWebSocketService(): WebSocketNetworkService | null {
  return wsServiceInstance;
}

/**
 * Initialize the global WebSocket service
 */
export function initWebSocketService(
  options: WebSocketServiceOptions
): WebSocketNetworkService {
  if (wsServiceInstance) {
    wsServiceInstance.disconnect();
  }
  wsServiceInstance = new WebSocketNetworkService(options);
  return wsServiceInstance;
}
