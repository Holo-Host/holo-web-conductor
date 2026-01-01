/**
 * .happ/.dna Bundle Unpacker
 *
 * Unpacks gzip+msgpack bundles to extract manifests and resources.
 * Matches Holochain's mr_bundle crate behavior.
 */

import { ungzip } from 'pako';
import { decode } from '@msgpack/msgpack';
import {
  AppBundle,
  DnaBundle,
  AppManifestV0,
  DnaManifestV0,
  DnaManifestRuntime,
  ZomeDefinition,
  BundleError,
  BundleErrorCode,
} from '../types/bundle-types';
import { toUint8Array } from '../utils/bytes';

/**
 * Unpack a .happ bundle
 */
export function unpackHappBundle(bytes: Uint8Array): AppBundle {
  try {
    // 1. Decompress gzip
    const decompressed = ungzip(bytes);

    // 2. Decode MessagePack
    const decoded = decode(decompressed) as Record<string, unknown>;

    // 3. Extract manifest (already parsed by msgpack)
    const manifest = decoded.manifest as AppManifestV0;
    if (!manifest) {
      throw new BundleError(
        'Missing manifest field in bundle',
        BundleErrorCode.INVALID_FORMAT
      );
    }

    // 4. Extract resources (DNA bundles)
    const resourcesObj = decoded.resources as Record<string, unknown>;
    const resources = new Map<string, Uint8Array>();
    for (const [key, value] of Object.entries(resourcesObj || {})) {
      resources.set(key, toUint8Array(value));
    }

    console.log(`[unpackHappBundle] Unpacked hApp: ${manifest.name}`);
    console.log(`[unpackHappBundle] Roles: ${manifest.roles.length}`);
    console.log(`[unpackHappBundle] Resources: ${resources.size}`);

    return { manifest, resources };

  } catch (error) {
    if (error instanceof BundleError) throw error;

    throw new BundleError(
      `Failed to unpack .happ bundle: ${error instanceof Error ? error.message : String(error)}`,
      BundleErrorCode.INVALID_FORMAT,
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Unpack a .dna bundle
 */
export function unpackDnaBundle(bytes: Uint8Array): DnaBundle {
  try {
    // 1. Decompress gzip
    const decompressed = ungzip(bytes);

    // 2. Decode MessagePack
    const decoded = decode(decompressed) as Record<string, unknown>;

    // 3. Extract manifest (already parsed by msgpack)
    const manifest = decoded.manifest as DnaManifestV0;
    if (!manifest) {
      throw new BundleError(
        'Missing manifest field in DNA bundle',
        BundleErrorCode.INVALID_FORMAT
      );
    }

    // 4. Extract resources (WASM files)
    const resourcesObj = decoded.resources as Record<string, unknown>;
    const resources = new Map<string, Uint8Array>();
    for (const [key, value] of Object.entries(resourcesObj || {})) {
      resources.set(key, toUint8Array(value));
    }

    console.log(`[unpackDnaBundle] Unpacked DNA: ${manifest.name}`);
    console.log(`[unpackDnaBundle] Integrity zomes: ${manifest.integrity.zomes.length}`);
    console.log(`[unpackDnaBundle] Coordinator zomes: ${manifest.coordinator.zomes.length}`);
    console.log(`[unpackDnaBundle] Resources: ${resources.size}`);

    return { manifest, resources };

  } catch (error) {
    if (error instanceof BundleError) throw error;

    throw new BundleError(
      `Failed to unpack .dna bundle: ${error instanceof Error ? error.message : String(error)}`,
      BundleErrorCode.INVALID_FORMAT,
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Convert DnaManifestV0 to runtime-usable DnaManifestRuntime
 */
export function createRuntimeManifest(
  manifest: DnaManifestV0,
  resources: Map<string, Uint8Array>
): DnaManifestRuntime {
  // Build integrity zome definitions
  const integrityZomes: ZomeDefinition[] = manifest.integrity.zomes.map((zome, index) => {
    const wasm = resources.get(zome.path);
    if (!wasm) {
      console.warn(`[createRuntimeManifest] Missing WASM for integrity zome: ${zome.name} at ${zome.path}`);
    }

    return {
      name: zome.name,
      index,
      wasm,
      dependencies: zome.dependencies?.map(d => d.name) || [],
    };
  });

  // Build coordinator zome definitions
  const coordinatorZomes: ZomeDefinition[] = manifest.coordinator.zomes.map((zome, index) => {
    const wasm = resources.get(zome.path);
    if (!wasm) {
      console.warn(`[createRuntimeManifest] Missing WASM for coordinator zome: ${zome.name} at ${zome.path}`);
    }

    return {
      name: zome.name,
      index: integrityZomes.length + index,
      wasm,
      dependencies: zome.dependencies?.map(d => d.name) || [],
    };
  });

  return {
    name: manifest.name,
    network_seed: manifest.integrity.network_seed,
    properties: manifest.integrity.properties,
    integrity_zomes: integrityZomes,
    coordinator_zomes: coordinatorZomes,
  };
}

/**
 * Extract WASM for a specific zome from DNA bundle
 */
export function extractZomeWasm(
  dnaBundle: DnaBundle,
  zomeName: string
): Uint8Array | null {
  // Check integrity zomes
  const integrityZome = dnaBundle.manifest.integrity.zomes.find(z => z.name === zomeName);
  if (integrityZome) {
    return dnaBundle.resources.get(integrityZome.path) || null;
  }

  // Check coordinator zomes
  const coordinatorZome = dnaBundle.manifest.coordinator.zomes.find(z => z.name === zomeName);
  if (coordinatorZome) {
    return dnaBundle.resources.get(coordinatorZome.path) || null;
  }

  return null;
}

/**
 * Get first available WASM from DNA bundle (for single-zome DNAs)
 */
export function getFirstWasm(dnaBundle: DnaBundle): Uint8Array | null {
  // Try integrity zomes first
  for (const zome of dnaBundle.manifest.integrity.zomes) {
    const wasm = dnaBundle.resources.get(zome.path);
    if (wasm) return wasm;
  }

  // Try coordinator zomes
  for (const zome of dnaBundle.manifest.coordinator.zomes) {
    const wasm = dnaBundle.resources.get(zome.path);
    if (wasm) return wasm;
  }

  return null;
}
