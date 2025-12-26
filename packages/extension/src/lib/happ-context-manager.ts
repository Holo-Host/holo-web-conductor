/**
 * hApp Context Manager - Business logic for context lifecycle
 *
 * Orchestrates:
 * - HappContextStorage (persistence)
 * - Lair keystore (agent keys)
 * - Permission manager (authorization)
 */

import type { HappContext, InstallHappRequest, CellId } from "@fishy/core";
import { HappContextStorage, getHappContextStorage } from "./happ-context-storage";
import { createLairClient, type ILairClient } from "@fishy/lair";
import { getPermissionManager, type PermissionManager } from "./permissions";

/**
 * hApp context manager
 */
export class HappContextManager {
  private storage: HappContextStorage;
  private lairClient: ILairClient | null = null;
  private permissionManager: PermissionManager;
  private ready: Promise<void>;

  constructor(
    storage?: HappContextStorage,
    lairClient?: ILairClient,
    permissionManager?: PermissionManager
  ) {
    this.storage = storage || getHappContextStorage();
    this.lairClient = lairClient || null;
    this.permissionManager = permissionManager || getPermissionManager();
    this.ready = this.initialize();
  }

  /**
   * Get or create Lair client instance
   */
  private async getLairClient(): Promise<ILairClient> {
    if (!this.lairClient) {
      this.lairClient = await createLairClient();
    }
    return this.lairClient;
  }

  /**
   * Initialize manager
   */
  private async initialize(): Promise<void> {
    // Ensure all dependencies are ready
    await Promise.all([
      this.storage["ready"],
      this.permissionManager["ready"],
    ]);
    console.log("[HappContextManager] Initialized");
  }

  /**
   * Ensure manager is ready
   */
  private async ensureReady(): Promise<void> {
    await this.ready;
  }

  /**
   * Install a hApp for a domain
   *
   * @throws Error if domain not authorized
   * @throws Error if context already exists for domain
   */
  async installHapp(domain: string, request: InstallHappRequest): Promise<HappContext> {
    await this.ensureReady();

    // 1. Check permission
    const permission = await this.permissionManager.checkPermission(domain);
    if (!permission?.granted) {
      throw new Error(`Domain ${domain} is not authorized`);
    }

    // 2. Check if context already exists
    const existing = await this.storage.getContextByDomain(domain);
    if (existing) {
      throw new Error(`hApp already installed for ${domain}`);
    }

    // 3. Generate context ID
    const contextId = crypto.randomUUID();

    // 4. Create agent key in Lair
    const agentKeyTag = `${domain}:agent`;
    console.log(`[HappContextManager] Creating agent key: ${agentKeyTag}`);

    const lair = await this.getLairClient();
    const keyResult = await lair.newSeed(agentKeyTag, false);
    const agentPubKey = keyResult.entry_info.ed25519_pub_key;

    // 5. Store DNA WASM separately
    console.log(`[HappContextManager] Storing ${request.dnas.length} DNA(s) for ${domain}`);
    for (const dna of request.dnas) {
      await this.storage.putDnaWasm(dna.hash, dna.wasm);
    }

    // 6. Create context
    const context: HappContext = {
      id: contextId,
      domain,
      agentPubKey,
      agentKeyTag,
      dnas: request.dnas.map((dna) => ({
        hash: dna.hash,
        wasm: dna.wasm,
        name: dna.name,
        properties: dna.properties,
      })),
      appName: request.appName,
      appVersion: request.appVersion,
      installedAt: Date.now(),
      lastUsed: Date.now(),
      enabled: true,
    };

    await this.storage.putContext(context);

    console.log(
      `[HappContextManager] Installed hApp "${request.appName || contextId}" for ${domain}`
    );

    return context;
  }

  /**
   * Get context for a domain
   */
  async getContextForDomain(domain: string): Promise<HappContext | null> {
    await this.ensureReady();
    return this.storage.getContextByDomain(domain);
  }

  /**
   * Get context by ID
   */
  async getContext(id: string): Promise<HappContext | null> {
    await this.ensureReady();
    return this.storage.getContext(id);
  }

  /**
   * Uninstall a hApp
   *
   * Removes:
   * - Context from storage
   * - Agent key from Lair
   * - DNA WASM (if not referenced by other contexts)
   */
  async uninstallHapp(contextId: string): Promise<void> {
    await this.ensureReady();

    const context = await this.storage.getContext(contextId);
    if (!context) {
      throw new Error(`Context ${contextId} not found`);
    }

    console.log(`[HappContextManager] Uninstalling hApp ${contextId} (${context.domain})`);

    // 1. Delete agent key from Lair
    try {
      const lair = await this.getLairClient();
      await lair.deleteEntry(context.agentKeyTag);
      console.log(`[HappContextManager] Deleted agent key: ${context.agentKeyTag}`);
    } catch (error) {
      console.warn(`[HappContextManager] Failed to delete agent key:`, error);
      // Continue with uninstall even if key deletion fails
    }

    // 2. Delete DNA WASM (simple approach - delete all, could optimize with ref counting)
    for (const dna of context.dnas) {
      try {
        await this.storage.deleteDnaWasm(dna.hash);
      } catch (error) {
        console.warn(`[HappContextManager] Failed to delete DNA WASM:`, error);
        // Continue with uninstall
      }
    }

    // 3. Delete context
    await this.storage.deleteContext(contextId);

    console.log(`[HappContextManager] Uninstalled hApp ${contextId}`);
  }

  /**
   * Enable or disable a context
   */
  async setContextEnabled(contextId: string, enabled: boolean): Promise<void> {
    await this.ensureReady();

    const context = await this.storage.getContext(contextId);
    if (!context) {
      throw new Error(`Context ${contextId} not found`);
    }

    context.enabled = enabled;
    await this.storage.putContext(context);

    console.log(
      `[HappContextManager] ${enabled ? "Enabled" : "Disabled"} context ${contextId}`
    );
  }

  /**
   * List all contexts
   */
  async listContexts(): Promise<HappContext[]> {
    await this.ensureReady();
    return this.storage.listContexts();
  }

  /**
   * Update last used timestamp for a context
   */
  async touchContext(contextId: string): Promise<void> {
    await this.ensureReady();
    await this.storage.updateLastUsed(contextId);
  }

  /**
   * Get cell IDs for a context
   *
   * Returns array of [DnaHash, AgentPubKey] pairs
   */
  getCellIds(context: HappContext): CellId[] {
    return context.dnas.map((dna) => [dna.hash, context.agentPubKey]);
  }
}

// Singleton instance
let instance: HappContextManager | null = null;

/**
 * Get singleton instance of HappContextManager
 */
export function getHappContextManager(): HappContextManager {
  if (!instance) {
    instance = new HappContextManager();
  }
  return instance;
}

/**
 * Reset singleton (for testing)
 */
export function resetHappContextManager(): void {
  instance = null;
}
