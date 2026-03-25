/**
 * hApp Context Manager - Business logic for context lifecycle
 *
 * Orchestrates:
 * - HappContextStorage (persistence)
 * - Lair keystore (agent keys)
 * - Permission manager (authorization)
 */

import type { HappContext, HappContextStatus, InstallHappRequest, CellId, DnaContext } from "@hwc/core";
import { HappContextStorage, getHappContextStorage } from "./happ-context-storage";
import { createLairClient, type ILairClient } from "@holo-host/lair";
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
import { createLogger } from '@hwc/shared';
const log = createLogger('HappContext');

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
    log.info("Initialized");
  }

  /**
   * Ensure manager is ready
   */
  private async ensureReady(): Promise<void> {
    await this.ready;
  }

  /**
   * Get or create an agent key for a domain.
   * Returns a 39-byte AgentPubKey HoloHash.
   * Idempotent: reuses existing key if one was already created for this domain.
   */
  async getOrCreateAgentKey(domain: string): Promise<Uint8Array> {
    await this.ready;
    const agentKeyTag = `${domain}:agent`;
    const lair = await this.getLairClient();
    let rawEd25519Key: Uint8Array;

    const existingEntry = await lair.getEntry(agentKeyTag);
    if (existingEntry) {
      rawEd25519Key = existingEntry.ed25519_pub_key;
    } else {
      const keyResult = await lair.newSeed(agentKeyTag, true);
      rawEd25519Key = keyResult.entry_info.ed25519_pub_key;
    }
    return wrapAsAgentPubKey(rawEd25519Key);
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

    log.info(`Installing hApp for domain: ${domain}`);

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
      const appBundle: AppBundle = unpackHappBundle(request.happBundle);

      // 4. Create or reuse agent key for this domain
      // If the caller provides an agentKeyTag (pre-existing key for one-step genesis
      // with membrane proof), use it; otherwise derive from domain.
      const agentKeyTag = request.agentKeyTag || `${domain}:agent`;
      log.debug(`Creating/reusing agent key: ${agentKeyTag}`);

      const lair = await this.getLairClient();
      let rawEd25519Key: Uint8Array;

      const existingEntry = await lair.getEntry(agentKeyTag);
      if (existingEntry) {
        rawEd25519Key = existingEntry.ed25519_pub_key;
      } else {
        const keyResult = await lair.newSeed(agentKeyTag, true);
        rawEd25519Key = keyResult.entry_info.ed25519_pub_key;
      }
      // Wrap raw Ed25519 key (32 bytes) as AgentPubKey HoloHash (39 bytes)
      const agentPubKey = wrapAsAgentPubKey(rawEd25519Key);

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
        const effectiveNetworkSeed = role.dna.modifiers?.network_seed ||
          dnaBundle.manifest.integrity.network_seed || undefined;

        const dnaContext: DnaContext = {
          hash: dnaHash,
          wasm,
          name: dnaBundle.manifest.name,
          properties:
            role.dna.modifiers?.properties ||
            dnaBundle.manifest.integrity.properties,
          networkSeed: effectiveNetworkSeed,
          manifest: runtimeManifest,
        };

        dnaContexts.push(dnaContext);

        // Store DNA WASM separately for deduplication
        await this.storage.putDnaWasm(dnaHash, wasm);

        log.debug(`Processed DNA: ${dnaContext.name}`, {
          hash: encodeHashToBase64(dnaHash),
          wasmSize: wasm.length,
          integrityZomes: runtimeManifest.integrity_zomes.length,
          coordinatorZomes: runtimeManifest.coordinator_zomes.length,
        });
      }

      if (dnaContexts.length === 0) {
        throw new Error("No DNAs were successfully processed from .happ bundle");
      }

      // 6. Determine initial status
      // When allow_deferred_memproofs=true, genesis MUST run before the context is
      // enabled. We always park the context as awaitingMemproofs regardless of whether
      // membrane proofs were included in this request. The background handler will
      // immediately run genesis if proofs are provided, transitioning to enabled.
      // This ensures the chain is always initialised before a context goes live.
      const deferredRequested = appBundle.manifest.allow_deferred_memproofs === true;
      const awaitingMemproofs = deferredRequested;

      const status: HappContextStatus = awaitingMemproofs ? 'awaitingMemproofs' : 'enabled';

      if (awaitingMemproofs) {
        const memproofsProvided = request.membraneProofs !== undefined;
        log.debug(`App has allow_deferred_memproofs=true - context awaiting genesis (memproofs ${memproofsProvided ? 'provided, will run immediately' : 'not provided, deferred'})`);
      }

      // 7. Create HappContext
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
        enabled: !awaitingMemproofs,
        status,
      };

      // 8. Store context
      await this.storage.putContext(context);

      log.info(`Installed hApp: ${context.appName}`, {
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

    log.info(`Uninstalling hApp ${contextId} (${context.domain})`);

    // 1. Delete agent key from Lair
    try {
      const lair = await this.getLairClient();
      await lair.deleteEntry(context.agentKeyTag);
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

    log.info(`Uninstalled hApp ${contextId}`);
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

    if (context.status === 'awaitingMemproofs') {
      throw new Error('Cannot enable app that is awaiting membrane proofs. Provide membrane proofs first.');
    }

    context.enabled = enabled;
    context.status = enabled ? 'enabled' : 'disabled';
    await this.storage.putContext(context);

    log.info(`${enabled ? "Enabled" : "Disabled"} context ${contextId}`);
  }

  /**
   * Provide membrane proofs for a context that is awaiting them.
   *
   * Validates state and returns the context. The caller must run
   * genesis_self_check + initializeGenesis, then call completeMemproofs()
   * on success.
   */
  async provideMemproofs(contextId: string, memproofs: Record<string, Uint8Array>): Promise<HappContext> {
    await this.ensureReady();

    const context = await this.storage.getContext(contextId);
    if (!context) {
      throw new Error(`Context not found: ${contextId}`);
    }
    if (context.status !== 'awaitingMemproofs') {
      throw new Error(`Context ${contextId} is not awaiting membrane proofs (status: ${context.status})`);
    }

    // Return context unchanged - caller runs genesis validation before enabling
    return context;
  }

  /**
   * Transitions the context from 'awaitingMemproofs' to 'enabled'.
   * Called after genesis_self_check passes and initializeGenesis succeeds.
   */
  async completeMemproofs(contextId: string): Promise<HappContext> {
    await this.ensureReady();

    const context = await this.storage.getContext(contextId);
    if (!context) {
      throw new Error(`Context not found: ${contextId}`);
    }

    context.status = 'enabled';
    context.enabled = true;
    await this.storage.putContext(context);

    log.info(`Membrane proofs accepted for context ${contextId} - status set to 'enabled'`);

    return context;
  }

  /**
   * Mark that recovery has been run for a context.
   * Sets recoverySealed to false (recovery window open, retry allowed).
   * No-op if already sealed (prevents reopening after writes).
   */
  async markRecoveryRun(contextId: string): Promise<void> {
    await this.ensureReady();
    const context = await this.storage.getContext(contextId);
    if (!context) return;
    if (context.recoverySealed === true) return;
    context.recoverySealed = false;
    await this.storage.putContext(context);
    log.debug(`Recovery run marked for context ${contextId}`);
  }

  /**
   * Seal recovery for a context (permanently block further recovery).
   * Called on first chain-writing zome call after recovery.
   */
  async sealRecovery(contextId: string): Promise<void> {
    await this.ensureReady();
    const context = await this.storage.getContext(contextId);
    if (!context) return;
    if (context.recoverySealed === true) return;
    context.recoverySealed = true;
    await this.storage.putContext(context);
    log.debug(`Recovery sealed for context ${contextId}`);
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
