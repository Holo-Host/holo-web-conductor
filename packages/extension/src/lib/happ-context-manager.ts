/**
 * hApp Context Manager - Business logic for context lifecycle
 *
 * Orchestrates:
 * - HappContextStorage (persistence)
 * - Lair keystore (agent keys)
 * - Permission manager (authorization)
 */

import type { HappContext, InstallHappRequest, CellId, DnaContext } from "@fishy/core";
import { HappContextStorage, getHappContextStorage } from "./happ-context-storage";
import { createLairClient, type ILairClient } from "@fishy/lair";
import { getPermissionManager, type PermissionManager } from "./permissions";
import {
  unpackHappBundle,
  unpackDnaBundle,
  createRuntimeManifest,
  getFirstWasm,
  BundleError,
} from "@fishy/core";
import { encodeHashToBase64, HoloHashType, hashFrom32AndType } from "@holochain/client";
import type { AppBundle, DnaBundle, DnaManifestRuntime } from "@fishy/core";

/**
 * Convert a raw Ed25519 public key (32 bytes) to an AgentPubKey HoloHash (39 bytes)
 * Uses @holochain/client's hashFrom32AndType for proper hash construction
 */
function wrapAsAgentPubKey(ed25519PubKey: Uint8Array): Uint8Array {
  if (ed25519PubKey.length !== 32) {
    throw new Error(`Expected 32-byte Ed25519 key, got ${ed25519PubKey.length} bytes`);
  }
  return hashFrom32AndType(ed25519PubKey, HoloHashType.Agent);
}

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
   * Compute DNA hash from WASM bytes in proper Holochain format (39 bytes)
   *
   * Holochain hash format:
   * - 3 bytes: Core prefix [0x84, 0x20, 0x24] for DNA hash
   * - 32 bytes: SHA-256 hash content
   * - 4 bytes: DHT location (first 4 bytes of hash)
   *
   * TODO: Proper hashing with network seed and properties (Step 6)
   */
  private async computeDnaHash(wasm: Uint8Array): Promise<Uint8Array> {
    const hashBuffer = await crypto.subtle.digest("SHA-256", wasm);
    const hashBytes = new Uint8Array(hashBuffer);

    // Build proper 39-byte Holochain DNA hash
    // Core prefix for DNA hash: 0x84 (composite), 0x20 (dna type), 0x24 (36 bytes follow)
    const DNA_HASH_PREFIX = new Uint8Array([0x84, 0x20, 0x24]);

    // DHT location is first 4 bytes of the hash
    const dhtLocation = hashBytes.slice(0, 4);

    // Combine: prefix (3) + hash (32) + location (4) = 39 bytes
    const fullHash = new Uint8Array(39);
    fullHash.set(DNA_HASH_PREFIX, 0);
    fullHash.set(hashBytes, 3);
    fullHash.set(dhtLocation, 35);

    return fullHash;
  }

  /**
   * Install a hApp for a domain
   *
   * @throws Error if domain not authorized
   * @throws Error if context already exists for domain
   */
  async installHapp(domain: string, request: InstallHappRequest): Promise<HappContext> {
    await this.ensureReady();

    console.log(`[HappContextManager] Installing hApp for domain: ${domain}`);

    try {
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

      // 3. Unpack .happ bundle
      console.log(
        `[HappContextManager] Unpacking .happ bundle (${request.happBundle.length} bytes)`
      );
      const appBundle: AppBundle = unpackHappBundle(request.happBundle);

      console.log(`[HappContextManager] hApp manifest:`, {
        name: appBundle.manifest.name,
        roles: appBundle.manifest.roles.length,
        resources: appBundle.resources.size,
      });

      // 4. Create or get agent key for this domain
      const agentKeyTag = `${domain}:agent`;
      console.log(`[HappContextManager] Creating agent key: ${agentKeyTag}`);

      const lair = await this.getLairClient();
      const keyResult = await lair.newSeed(agentKeyTag, false);
      // Wrap raw Ed25519 key (32 bytes) as AgentPubKey HoloHash (39 bytes)
      const agentPubKey = wrapAsAgentPubKey(keyResult.entry_info.ed25519_pub_key);

      // 5. Process each DNA role
      const dnaContexts: DnaContext[] = [];

      for (const role of appBundle.manifest.roles) {
        if (!role.dna.path) {
          console.warn(
            `[HappContextManager] Role ${role.name} has no DNA path, skipping`
          );
          continue;
        }

        // Get DNA bundle from resources
        const dnaBytes = appBundle.resources.get(role.dna.path);
        if (!dnaBytes) {
          throw new BundleError(
            `Missing DNA bundle for role: ${role.name} at ${role.dna.path}`,
            "MISSING_RESOURCE"
          );
        }

        // Unpack DNA bundle
        console.log(
          `[HappContextManager] Unpacking DNA bundle for role: ${role.name}`
        );
        const dnaBundle: DnaBundle = unpackDnaBundle(dnaBytes);

        // Create runtime manifest
        const runtimeManifest: DnaManifestRuntime = createRuntimeManifest(
          dnaBundle.manifest,
          dnaBundle.resources
        );

        // Get WASM (use first available for now - multi-zome support in Step 6)
        const wasm = getFirstWasm(dnaBundle);
        if (!wasm) {
          throw new BundleError(
            `No WASM found in DNA bundle for role: ${role.name}`,
            "MISSING_RESOURCE"
          );
        }

        // Compute DNA hash (TODO: proper hash with modifiers)
        const dnaHash = await this.computeDnaHash(wasm);

        // Create DnaContext with manifest
        const dnaContext: DnaContext = {
          hash: dnaHash,
          wasm,
          name: dnaBundle.manifest.name,
          properties:
            role.dna.modifiers?.properties ||
            dnaBundle.manifest.integrity.properties,
          manifest: runtimeManifest,
        };

        dnaContexts.push(dnaContext);

        // Store DNA WASM separately for deduplication
        await this.storage.putDnaWasm(dnaHash, wasm);

        console.log(`[HappContextManager] Processed DNA: ${dnaContext.name}`, {
          hash: encodeHashToBase64(dnaHash),
          wasmSize: wasm.length,
          integrityZomes: runtimeManifest.integrity_zomes.length,
          coordinatorZomes: runtimeManifest.coordinator_zomes.length,
        });
      }

      if (dnaContexts.length === 0) {
        throw new Error("No DNAs were successfully processed from .happ bundle");
      }

      // 6. Create HappContext
      // Generate unique context ID (UUID v4)
      const contextId = crypto.randomUUID();
      const context: HappContext = {
        id: contextId,
        domain,
        agentPubKey,
        agentKeyTag,
        dnas: dnaContexts,
        appName: request.appName || appBundle.manifest.name,
        appVersion: request.appVersion,
        installedAt: Date.now(),
        lastUsed: Date.now(),
        enabled: true,
      };

      // 7. Store context
      await this.storage.putContext(context);

      console.log(`[HappContextManager] Installed hApp: ${context.appName}`, {
        id: context.id,
        dnas: context.dnas.length,
      });

      return context;
    } catch (error) {
      console.error("[HappContextManager] Failed to install hApp:", error);
      throw error;
    }
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
