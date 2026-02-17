/**
 * hApp Context Manager - Business logic for context lifecycle
 *
 * Orchestrates:
 * - HappContextStorage (persistence)
 * - Lair keystore (agent keys)
 * - Permission manager (authorization)
 */

import type { HappContext, InstallHappRequest, CellId, DnaContext } from "@hwc/core";
import { HappContextStorage, getHappContextStorage } from "./happ-context-storage";
import { createLairClient, type ILairClient } from "@hwc/lair";
import { getPermissionManager, type PermissionManager } from "./permissions";
import {
  unpackHappBundle,
  unpackDnaBundle,
  createRuntimeManifest,
  getFirstWasm,
  BundleError,
  computeDnaHash as computeDnaHashFromDef,
  computeWasmHash,
  type IntegrityZomeForHash,
  type DnaModifiersForHash,
} from "@hwc/core";
import { encodeHashToBase64, HoloHashType, hashFrom32AndType } from "@holochain/client";
import { encode as msgpackEncode } from "@msgpack/msgpack";
import type { AppBundle, DnaBundle, DnaManifestRuntime } from "@hwc/core";

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
   * Compute DNA hash from DNA definition (modifiers + integrity zomes)
   *
   * Holochain computes DNA hashes from:
   * - modifiers: { network_seed, properties }
   * - integrity_zomes: [(name, { wasm_hash, dependencies }), ...]
   *
   * NOTE: Coordinator zomes are NOT included in the DNA hash.
   */
  private computeDnaHashFromBundle(
    dnaBundle: DnaBundle,
    roleModifiers?: { network_seed?: string; properties?: Record<string, unknown> }
  ): Uint8Array {
    // Get network_seed and properties from role modifiers or DNA manifest
    const networkSeed = roleModifiers?.network_seed ||
      dnaBundle.manifest.integrity.network_seed ||
      "";
    const properties = roleModifiers?.properties ||
      dnaBundle.manifest.integrity.properties;

    // Encode properties as msgpack (SerializedBytes in Holochain)
    // When properties is null/undefined, Holochain uses msgpack-encoded () which is nil (0xc0)
    // When properties has a value, it's msgpack-encoded as that value
    const propertiesBytes = new Uint8Array(msgpackEncode(properties === undefined || properties === null ? null : properties));

    // Build integrity zomes array with WASM hashes
    const integrityZomes: IntegrityZomeForHash[] = [];

    for (const zomeManifest of dnaBundle.manifest.integrity.zomes) {
      // Get WASM bytes for this zome
      const wasmBytes = dnaBundle.resources.get(zomeManifest.path);
      if (!wasmBytes) {
        throw new BundleError(
          `Missing WASM for integrity zome: ${zomeManifest.name}`,
          "MISSING_RESOURCE"
        );
      }

      // Compute WASM hash
      const wasmHash = computeWasmHash(wasmBytes);

      // Get dependencies (integrity zomes don't have dependencies, but include for completeness)
      const dependencies = zomeManifest.dependencies?.map(d => d.name) || [];

      integrityZomes.push({
        name: zomeManifest.name,
        wasmHash,
        dependencies,
      });
    }

    // Build modifiers
    const modifiers: DnaModifiersForHash = {
      network_seed: networkSeed,
      properties: propertiesBytes,
    };

    // Compute DNA hash
    const dnaHash = computeDnaHashFromDef(modifiers, integrityZomes);

    console.log(`[HappContextManager] Computed DNA hash:`, {
      networkSeed,
      propertiesBytes: Array.from(propertiesBytes),
      integrityZomes: integrityZomes.map(z => ({
        name: z.name,
        wasmHash: encodeHashToBase64(z.wasmHash),
        dependencies: z.dependencies,
      })),
      hash: encodeHashToBase64(dnaHash),
    });

    return dnaHash;
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
      // Debug: Log the raw Ed25519 key that was created
      const rawEd25519Key = keyResult.entry_info.ed25519_pub_key;
      console.log(`[HappContextManager] Created Ed25519 key (first 8 bytes): ${Array.from(rawEd25519Key.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join('')}`);
      // Wrap raw Ed25519 key (32 bytes) as AgentPubKey HoloHash (39 bytes)
      const agentPubKey = wrapAsAgentPubKey(rawEd25519Key);
      console.log(`[HappContextManager] Wrapped as AgentPubKey (first 8 bytes): ${Array.from(agentPubKey.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join('')}`);

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

        // Get WASM (use first available for now - multi-zome support later)
        const wasm = getFirstWasm(dnaBundle);
        if (!wasm) {
          throw new BundleError(
            `No WASM found in DNA bundle for role: ${role.name}`,
            "MISSING_RESOURCE"
          );
        }

        // Compute DNA hash properly from modifiers + integrity zomes
        const dnaHash = this.computeDnaHashFromBundle(dnaBundle, role.dna.modifiers);

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
   * Validates that the agent key still exists in Lair - if not, deletes the stale context
   */
  async getContextForDomain(domain: string): Promise<HappContext | null> {
    await this.ensureReady();
    const context = await this.storage.getContextByDomain(domain);

    if (context) {
      // Validate that the agent key still exists in Lair
      const keyValid = await this.validateAgentKey(context);
      if (!keyValid) {
        console.warn(`[HappContextManager] Agent key for context ${context.id} no longer exists in Lair - deleting stale context`);
        await this.storage.deleteContext(context.id);
        return null;
      }
    }

    return context;
  }

  /**
   * Validate that the agent key for a context exists in Lair
   */
  private async validateAgentKey(context: HappContext): Promise<boolean> {
    try {
      const lair = await this.getLairClient();
      const entry = await lair.getEntry(context.agentKeyTag);
      return entry !== null;
    } catch (error) {
      console.warn(`[HappContextManager] Failed to validate agent key:`, error);
      return false;
    }
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
