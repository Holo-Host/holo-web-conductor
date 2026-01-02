/**
 * WebSocket Network Service
 *
 * Manages a WebSocket connection to the hc-http-gw for receiving remote signals.
 * This service is designed to run in the offscreen document where persistent
 * connections are supported.
 *
 * Protocol (see hc-http-gw-fork gateway):
 * - Browser → Gateway: auth, register, unregister, ping
 * - Gateway → Browser: auth_ok, auth_error, registered, unregistered, signal, pong, error
 */

/**
 * Messages from browser to gateway
 */
export type ClientMessage =
  | { type: "auth"; session_token: string }
  | { type: "register"; dna_hash: string; agent_pubkey: string }
  | { type: "unregister"; dna_hash: string; agent_pubkey: string }
  | { type: "ping" };

/**
 * Messages from gateway to browser
 */
export type ServerMessage =
  | { type: "auth_ok" }
  | { type: "auth_error"; message: string }
  | { type: "registered"; dna_hash: string; agent_pubkey: string }
  | { type: "unregistered"; dna_hash: string; agent_pubkey: string }
  | {
      type: "signal";
      dna_hash: string;
      from_agent: string;
      zome_name: string;
      signal: string; // base64-encoded signal payload
    }
  | { type: "pong" }
  | { type: "error"; message: string };

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
 * Signal callback - called when a signal is received from the gateway
 */
export type SignalCallback = (signal: {
  dna_hash: string;
  from_agent: string;
  zome_name: string;
  signal: Uint8Array; // decoded from base64
}) => void;

/**
 * Connection state callback
 */
export type StateCallback = (state: ConnectionState) => void;

/**
 * Options for WebSocket network service
 */
export interface WebSocketServiceOptions {
  /** Gateway WebSocket URL (e.g., "ws://localhost:8090/ws") */
  gatewayWsUrl: string;
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
 * Manages connection to gateway for remote signal delivery.
 */
export class WebSocketNetworkService {
  private ws: WebSocket | null = null;
  private options: Required<WebSocketServiceOptions>;
  private state: ConnectionState = "disconnected";
  private registrations: AgentRegistration[] = [];
  private pendingRegistrations: AgentRegistration[] = [];
  private signalCallback: SignalCallback | null = null;
  private stateCallback: StateCallback | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private authenticated = false;
  private intentionalClose = false;

  constructor(options: WebSocketServiceOptions) {
    this.options = {
      gatewayWsUrl: options.gatewayWsUrl,
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
   * Update session token (can be called before or after connection)
   */
  setSessionToken(token: string | null): void {
    this.options.sessionToken = token || "";

    // If connected but not authenticated, try to authenticate now
    if (this.state === "connected" && !this.authenticated && token) {
      this.authenticate();
    }
  }

  /**
   * Connect to the gateway WebSocket
   */
  connect(): void {
    if (this.ws) {
      console.log("[WebSocketService] Already connected or connecting");
      return;
    }

    this.intentionalClose = false;
    this.setState("connecting");

    console.log(
      `[WebSocketService] Connecting to ${this.options.gatewayWsUrl}`
    );

    try {
      this.ws = new WebSocket(this.options.gatewayWsUrl);

      this.ws.onopen = () => this.handleOpen();
      this.ws.onmessage = (event) => this.handleMessage(event);
      this.ws.onerror = (event) => this.handleError(event);
      this.ws.onclose = (event) => this.handleClose(event);
    } catch (error) {
      console.error("[WebSocketService] Connection failed:", error);
      this.scheduleReconnect();
    }
  }

  /**
   * Disconnect from the gateway
   */
  disconnect(): void {
    console.log("[WebSocketService] Disconnecting");
    this.intentionalClose = true;
    this.cleanup();
    this.setState("disconnected");
  }

  /**
   * Register an agent to receive signals for a DNA
   */
  registerAgent(dna_hash: string, agent_pubkey: string): void {
    const registration = { dna_hash, agent_pubkey };

    // Check if already registered
    if (
      this.registrations.some(
        (r) => r.dna_hash === dna_hash && r.agent_pubkey === agent_pubkey
      )
    ) {
      console.log(
        `[WebSocketService] Agent already registered: ${agent_pubkey} for ${dna_hash}`
      );
      return;
    }

    if (this.isConnected()) {
      // Send registration immediately
      this.send({ type: "register", dna_hash, agent_pubkey });
      this.registrations.push(registration);
    } else {
      // Queue for when connected
      this.pendingRegistrations.push(registration);
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

  // ============================================================================
  // Private Methods
  // ============================================================================

  private setState(state: ConnectionState): void {
    if (this.state !== state) {
      console.log(`[WebSocketService] State: ${this.state} -> ${state}`);
      this.state = state;
      this.stateCallback?.(state);
    }
  }

  private handleOpen(): void {
    console.log("[WebSocketService] Connected");
    this.reconnectAttempts = 0;
    this.setState("authenticating");
    this.startHeartbeat();

    // Always authenticate - gateway requires auth before registrations
    // If no token, send empty auth (gateway accepts when no authenticator configured)
    this.authenticate();
  }

  private handleMessage(event: MessageEvent): void {
    try {
      const message = JSON.parse(event.data) as ServerMessage;
      console.log("[WebSocketService] Received:", message.type);

      switch (message.type) {
        case "auth_ok":
          this.handleAuthOk();
          break;

        case "auth_error":
          this.handleAuthError(message.message);
          break;

        case "registered":
          console.log(
            `[WebSocketService] Agent registered: ${message.agent_pubkey} for ${message.dna_hash}`
          );
          break;

        case "unregistered":
          console.log(
            `[WebSocketService] Agent unregistered: ${message.agent_pubkey} for ${message.dna_hash}`
          );
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
      }
    } catch (error) {
      console.error("[WebSocketService] Failed to parse message:", error);
    }
  }

  private handleError(event: Event): void {
    console.error("[WebSocketService] WebSocket error:", event);
  }

  private handleClose(event: CloseEvent): void {
    console.log(
      `[WebSocketService] Connection closed: code=${event.code}, reason=${event.reason}`
    );
    this.cleanup();

    if (!this.intentionalClose) {
      this.scheduleReconnect();
    } else {
      this.setState("disconnected");
    }
  }

  private authenticate(): void {
    // Always send auth - gateway requires authentication before accepting registrations
    // When no authenticator is configured on gateway, any token (including empty) is accepted
    console.log("[WebSocketService] Authenticating...");
    this.setState("authenticating");
    this.send({ type: "auth", session_token: this.options.sessionToken || "" });
  }

  private handleAuthOk(): void {
    console.log("[WebSocketService] Authenticated");
    this.authenticated = true;
    this.setState("connected");

    // Register pending agents
    this.processPendingRegistrations();
  }

  private handleAuthError(message: string): void {
    console.error("[WebSocketService] Authentication failed:", message);
    this.authenticated = false;
    // Stay connected but not authenticated - user can update token
    this.setState("connected");
  }

  private handleSignal(message: Extract<ServerMessage, { type: "signal" }>): void {
    console.log(
      `[WebSocketService] Signal from ${message.from_agent} (${message.zome_name})`
    );

    if (this.signalCallback) {
      try {
        // Decode base64 signal payload
        const signalBytes = Uint8Array.from(atob(message.signal), (c) =>
          c.charCodeAt(0)
        );

        this.signalCallback({
          dna_hash: message.dna_hash,
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
      console.log("[WebSocketService] Max reconnect attempts reached");
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

    console.log(
      `[WebSocketService] Reconnecting in ${Math.round(totalDelay)}ms (attempt ${this.reconnectAttempts + 1})`
    );

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
      console.log(`[WebSocketService] Processing ${this.pendingRegistrations.length} pending registrations`);
    }
    for (const registration of this.pendingRegistrations) {
      console.log(`[WebSocketService] Sending registration: ${registration.agent_pubkey.substring(0, 20)}... for ${registration.dna_hash.substring(0, 20)}...`);
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
