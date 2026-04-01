import type { ConnectionStatus } from "@hwc/shared";

interface ConnectionStatusDeps {
  getLinkerConfig: () => { linkerUrl: string; sessionToken?: string } | null;
  getExecutor: () => { isReady(): boolean; getWebSocketState(): Promise<{ isConnected: boolean; authenticated: boolean; peerCount?: number }> };
  log: { info(...args: any[]): void; warn?(...args: any[]): void };
}

export class ConnectionStatusManager {
  private status: ConnectionStatus = {
    httpHealthy: false,
    wsHealthy: false,
    authenticated: false,
    linkerUrl: null,
    lastChecked: 0,
  };

  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private readonly HEALTH_CHECK_INTERVAL_MS = 5000;
  private connectedPorts = new Set<chrome.runtime.Port>();

  private deps: ConnectionStatusDeps;

  constructor(deps: ConnectionStatusDeps) {
    this.deps = deps;
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  addPort(port: chrome.runtime.Port): void {
    this.connectedPorts.add(port);
  }

  removePort(port: chrome.runtime.Port): void {
    this.connectedPorts.delete(port);
  }

  sendStatusToPort(port: chrome.runtime.Port): void {
    port.postMessage({
      type: 'connectionStatusChange',
      payload: this.status,
    });
  }

  update(partial: Partial<ConnectionStatus>): void {
    const prev = { ...this.status };
    Object.assign(this.status, partial);
    this.status.lastChecked = Date.now();
    if (!this.statusEqual(prev, this.status)) {
      this.deps.log.info(`Connection status changed: http=${this.status.httpHealthy} ws=${this.status.wsHealthy} auth=${this.status.authenticated} peers=${this.status.peerCount} err=${this.status.lastError || 'none'}`);
      this.notifyConnectionStatusChange();
    }
  }

  startHealthChecks(): void {
    if (this.healthCheckInterval) return;

    this.checkLinkerHealth();

    this.healthCheckInterval = setInterval(() => this.checkLinkerHealth(), this.HEALTH_CHECK_INTERVAL_MS);
  }

  stopHealthChecks(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  private async checkLinkerHealth(): Promise<void> {
    const linkerConfig = this.deps.getLinkerConfig();
    if (!linkerConfig?.linkerUrl) {
      this.update({
        httpHealthy: false,
        wsHealthy: false,
        authenticated: false,
        linkerUrl: null,
        lastError: 'No linker configured',
        peerCount: undefined,
      });
      return;
    }

    let httpHealthy = false;
    let lastError: string | undefined;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const response = await fetch(`${linkerConfig.linkerUrl}/health`, {
        method: 'GET',
        signal: controller.signal,
      });
      clearTimeout(timeout);
      httpHealthy = response.ok;
      lastError = response.ok ? undefined : `HTTP ${response.status}`;
    } catch (error) {
      httpHealthy = false;
      lastError = error instanceof Error ? error.message : 'Connection failed';
    }

    let wsHealthy = this.status.wsHealthy;
    let authenticated = this.status.authenticated;
    let peerCount = this.status.peerCount;
    const executor = this.deps.getExecutor();
    if (executor.isReady()) {
      try {
        const wsState = await executor.getWebSocketState();
        wsHealthy = wsState.isConnected;
        authenticated = wsState.authenticated;
        peerCount = wsState.isConnected ? wsState.peerCount : undefined;
      } catch {
        // Keep whatever we had cached
      }
    }

    this.update({
      httpHealthy,
      wsHealthy,
      authenticated,
      linkerUrl: linkerConfig.linkerUrl,
      lastError,
      peerCount,
    });
  }

  private notifyConnectionStatusChange(): void {
    const message = {
      type: 'connectionStatusChange',
      payload: this.status,
    };

    for (const port of this.connectedPorts) {
      try {
        port.postMessage(message);
      } catch {
        this.connectedPorts.delete(port);
      }
    }
  }

  private statusEqual(a: ConnectionStatus, b: ConnectionStatus): boolean {
    return (
      a.httpHealthy === b.httpHealthy &&
      a.wsHealthy === b.wsHealthy &&
      a.authenticated === b.authenticated &&
      a.linkerUrl === b.linkerUrl &&
      a.lastError === b.lastError &&
      a.peerCount === b.peerCount
    );
  }
}
