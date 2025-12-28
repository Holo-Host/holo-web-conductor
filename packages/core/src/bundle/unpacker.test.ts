/**
 * Bundle Unpacker Tests
 *
 * Tests for .happ and .dna bundle unpacking functionality.
 */

import { describe, it, expect } from "vitest";
import { gzip } from "pako";
import { encode } from "@msgpack/msgpack";
import {
  unpackHappBundle,
  unpackDnaBundle,
  createRuntimeManifest,
  getFirstWasm,
  extractZomeWasm,
} from "./unpacker";
import type { AppManifestV0, DnaManifestV0 } from "../types/bundle-types";
import { BundleError } from "../types/bundle-types";

describe("Bundle Unpacker", () => {
  describe("unpackHappBundle", () => {
    it("should unpack a valid .happ bundle", () => {
      // Create mock .happ bundle
      // Note: manifest is stored as a parsed object in msgpack, not as YAML
      const manifest: AppManifestV0 = {
        manifest_version: "0",
        name: "test-happ",
        description: "Test hApp",
        roles: [
          {
            name: "test-role",
            provisioning: {
              Create: {
                deferred: false,
              },
            },
            dna: {
              path: "test.dna",
            },
          },
        ],
      };

      const bundle = {
        manifest,
        resources: {
          "test.dna": new Uint8Array([1, 2, 3, 4, 5]),
        },
      };

      const msgpack = encode(bundle);
      const compressed = gzip(msgpack);

      const result = unpackHappBundle(compressed);

      expect(result.manifest.manifest_version).toBe("0");
      expect(result.manifest.name).toBe("test-happ");
      expect(result.manifest.description).toBe("Test hApp");
      expect(result.manifest.roles).toHaveLength(1);
      expect(result.manifest.roles[0].name).toBe("test-role");
      expect(result.manifest.roles[0].dna.path).toBe("test.dna");
      expect(result.resources.size).toBe(1);
      expect(result.resources.get("test.dna")).toEqual(
        new Uint8Array([1, 2, 3, 4, 5])
      );
    });

    it("should throw on invalid gzip", () => {
      expect(() => unpackHappBundle(new Uint8Array([1, 2, 3]))).toThrow(
        BundleError
      );
    });

    it("should throw on missing manifest", () => {
      const bundle = {
        resources: {
          "test.dna": new Uint8Array([1, 2, 3]),
        },
      };

      const msgpack = encode(bundle);
      const compressed = gzip(msgpack);

      expect(() => unpackHappBundle(compressed)).toThrow(BundleError);
      expect(() => unpackHappBundle(compressed)).toThrow(/Missing manifest/);
    });

    it("should handle multiple roles", () => {
      const manifest: AppManifestV0 = {
        manifest_version: "0",
        name: "multi-role-happ",
        roles: [
          {
            name: "role-1",
            provisioning: { Create: { deferred: false } },
            dna: { path: "dna1.dna" },
          },
          {
            name: "role-2",
            provisioning: { Create: { deferred: false } },
            dna: { path: "dna2.dna" },
          },
        ],
      };

      const bundle = {
        manifest,
        resources: {
          "dna1.dna": new Uint8Array([1, 2]),
          "dna2.dna": new Uint8Array([3, 4]),
        },
      };

      const msgpack = encode(bundle);
      const compressed = gzip(msgpack);

      const result = unpackHappBundle(compressed);

      expect(result.manifest.roles).toHaveLength(2);
      expect(result.resources.size).toBe(2);
    });
  });

  describe("unpackDnaBundle", () => {
    it("should unpack a valid .dna bundle", () => {
      // Note: manifest is stored as a parsed object in msgpack, not as YAML
      const manifest: DnaManifestV0 = {
        manifest_version: "0",
        name: "test-dna",
        integrity: {
          network_seed: "test-seed",
          properties: { key: "value" },
          zomes: [
            {
              name: "test_zome",
              path: "test.wasm",
              dependencies: [],
            },
          ],
        },
        coordinator: {
          zomes: [],
        },
      };

      const bundle = {
        manifest,
        resources: {
          "test.wasm": new Uint8Array([0, 97, 115, 109]), // WASM magic bytes
        },
      };

      const msgpack = encode(bundle);
      const compressed = gzip(msgpack);

      const result = unpackDnaBundle(compressed);

      expect(result.manifest.manifest_version).toBe("0");
      expect(result.manifest.name).toBe("test-dna");
      expect(result.manifest.integrity.network_seed).toBe("test-seed");
      expect(result.manifest.integrity.properties).toEqual({ key: "value" });
      expect(result.manifest.integrity.zomes).toHaveLength(1);
      expect(result.manifest.integrity.zomes[0].name).toBe("test_zome");
      expect(result.manifest.integrity.zomes[0].path).toBe("test.wasm");
      expect(result.manifest.coordinator.zomes).toHaveLength(0);
      expect(result.resources.size).toBe(1);
      expect(result.resources.get("test.wasm")).toEqual(
        new Uint8Array([0, 97, 115, 109])
      );
    });

    it("should handle multiple integrity zomes", () => {
      const manifest: DnaManifestV0 = {
        manifest_version: "0",
        name: "multi-zome-dna",
        integrity: {
          zomes: [
            {
              name: "zome1",
              path: "zome1.wasm",
              dependencies: [],
            },
            {
              name: "zome2",
              path: "zome2.wasm",
              dependencies: [{ name: "zome1" }],
            },
          ],
        },
        coordinator: {
          zomes: [],
        },
      };

      const bundle = {
        manifest,
        resources: {
          "zome1.wasm": new Uint8Array([0, 97, 115, 109]),
          "zome2.wasm": new Uint8Array([0, 97, 115, 109]),
        },
      };

      const msgpack = encode(bundle);
      const compressed = gzip(msgpack);

      const result = unpackDnaBundle(compressed);

      expect(result.manifest.integrity.zomes).toHaveLength(2);
      expect(result.manifest.integrity.zomes[1].dependencies).toHaveLength(1);
      expect(result.manifest.integrity.zomes[1].dependencies![0].name).toBe(
        "zome1"
      );
    });

    it("should handle coordinator zomes", () => {
      const manifest: DnaManifestV0 = {
        manifest_version: "0",
        name: "coordinator-dna",
        integrity: {
          zomes: [
            {
              name: "integrity_zome",
              path: "integrity.wasm",
              dependencies: [],
            },
          ],
        },
        coordinator: {
          zomes: [
            {
              name: "coordinator_zome",
              path: "coordinator.wasm",
              dependencies: [{ name: "integrity_zome" }],
            },
          ],
        },
      };

      const bundle = {
        manifest,
        resources: {
          "integrity.wasm": new Uint8Array([0, 97, 115, 109]),
          "coordinator.wasm": new Uint8Array([0, 97, 115, 109]),
        },
      };

      const msgpack = encode(bundle);
      const compressed = gzip(msgpack);

      const result = unpackDnaBundle(compressed);

      expect(result.manifest.integrity.zomes).toHaveLength(1);
      expect(result.manifest.coordinator.zomes).toHaveLength(1);
      expect(result.manifest.coordinator.zomes[0].name).toBe("coordinator_zome");
    });

    it("should throw on invalid gzip", () => {
      expect(() => unpackDnaBundle(new Uint8Array([1, 2, 3]))).toThrow(
        BundleError
      );
    });

    it("should throw on missing manifest", () => {
      const bundle = {
        resources: {
          "test.wasm": new Uint8Array([0, 97, 115, 109]),
        },
      };

      const msgpack = encode(bundle);
      const compressed = gzip(msgpack);

      expect(() => unpackDnaBundle(compressed)).toThrow(BundleError);
      expect(() => unpackDnaBundle(compressed)).toThrow(/Missing manifest/);
    });
  });

  describe("createRuntimeManifest", () => {
    it("should create runtime manifest with zome definitions", () => {
      const manifest: DnaManifestV0 = {
        manifest_version: "0",
        name: "test-dna",
        integrity: {
          network_seed: "test-seed",
          properties: { key: "value" },
          zomes: [
            {
              name: "integrity_zome",
              path: "integrity.wasm",
              dependencies: [],
            },
          ],
        },
        coordinator: {
          zomes: [
            {
              name: "coordinator_zome",
              path: "coordinator.wasm",
              dependencies: [{ name: "integrity_zome" }],
            },
          ],
        },
      };

      const resources = new Map([
        ["integrity.wasm", new Uint8Array([1, 2, 3])],
        ["coordinator.wasm", new Uint8Array([4, 5, 6])],
      ]);

      const runtime = createRuntimeManifest(manifest, resources);

      expect(runtime.name).toBe("test-dna");
      expect(runtime.network_seed).toBe("test-seed");
      expect(runtime.properties).toEqual({ key: "value" });
      expect(runtime.integrity_zomes).toHaveLength(1);
      expect(runtime.coordinator_zomes).toHaveLength(1);

      // Check integrity zome
      expect(runtime.integrity_zomes[0].name).toBe("integrity_zome");
      expect(runtime.integrity_zomes[0].index).toBe(0);
      expect(runtime.integrity_zomes[0].wasm).toEqual(new Uint8Array([1, 2, 3]));
      expect(runtime.integrity_zomes[0].dependencies).toEqual([]);

      // Check coordinator zome
      expect(runtime.coordinator_zomes[0].name).toBe("coordinator_zome");
      expect(runtime.coordinator_zomes[0].index).toBe(1); // After integrity zomes
      expect(runtime.coordinator_zomes[0].wasm).toEqual(
        new Uint8Array([4, 5, 6])
      );
      expect(runtime.coordinator_zomes[0].dependencies).toEqual([
        "integrity_zome",
      ]);
    });

    it("should assign correct indices to zomes", () => {
      const manifest: DnaManifestV0 = {
        manifest_version: "0",
        name: "test-dna",
        integrity: {
          zomes: [
            { name: "int1", path: "int1.wasm", dependencies: [] },
            { name: "int2", path: "int2.wasm", dependencies: [] },
          ],
        },
        coordinator: {
          zomes: [
            { name: "coord1", path: "coord1.wasm", dependencies: [] },
            { name: "coord2", path: "coord2.wasm", dependencies: [] },
          ],
        },
      };

      const resources = new Map([
        ["int1.wasm", new Uint8Array([1])],
        ["int2.wasm", new Uint8Array([2])],
        ["coord1.wasm", new Uint8Array([3])],
        ["coord2.wasm", new Uint8Array([4])],
      ]);

      const runtime = createRuntimeManifest(manifest, resources);

      expect(runtime.integrity_zomes[0].index).toBe(0);
      expect(runtime.integrity_zomes[1].index).toBe(1);
      expect(runtime.coordinator_zomes[0].index).toBe(2); // After 2 integrity zomes
      expect(runtime.coordinator_zomes[1].index).toBe(3);
    });

    it("should handle missing WASM resources gracefully", () => {
      const manifest: DnaManifestV0 = {
        manifest_version: "0",
        name: "test-dna",
        integrity: {
          zomes: [{ name: "test_zome", path: "missing.wasm", dependencies: [] }],
        },
        coordinator: {
          zomes: [],
        },
      };

      const resources = new Map(); // Empty resources

      const runtime = createRuntimeManifest(manifest, resources);

      expect(runtime.integrity_zomes[0].wasm).toBeUndefined();
    });
  });

  describe("getFirstWasm", () => {
    it("should return first integrity zome WASM", () => {
      const dnaBundle = {
        manifest: {
          manifest_version: "0" as const,
          name: "test-dna",
          integrity: {
            zomes: [{ name: "int_zome", path: "int.wasm", dependencies: [] }],
          },
          coordinator: {
            zomes: [],
          },
        },
        resources: new Map([["int.wasm", new Uint8Array([1, 2, 3])]]),
      };

      const wasm = getFirstWasm(dnaBundle);

      expect(wasm).toEqual(new Uint8Array([1, 2, 3]));
    });

    it("should fallback to coordinator zome if no integrity zomes", () => {
      const dnaBundle = {
        manifest: {
          manifest_version: "0" as const,
          name: "test-dna",
          integrity: {
            zomes: [],
          },
          coordinator: {
            zomes: [{ name: "coord_zome", path: "coord.wasm", dependencies: [] }],
          },
        },
        resources: new Map([["coord.wasm", new Uint8Array([4, 5, 6])]]),
      };

      const wasm = getFirstWasm(dnaBundle);

      expect(wasm).toEqual(new Uint8Array([4, 5, 6]));
    });

    it("should return null if no WASM found", () => {
      const dnaBundle = {
        manifest: {
          manifest_version: "0" as const,
          name: "test-dna",
          integrity: {
            zomes: [{ name: "test", path: "missing.wasm", dependencies: [] }],
          },
          coordinator: {
            zomes: [],
          },
        },
        resources: new Map(), // Empty
      };

      const wasm = getFirstWasm(dnaBundle);

      expect(wasm).toBeNull();
    });

    it("should return null for empty zome lists", () => {
      const dnaBundle = {
        manifest: {
          manifest_version: "0" as const,
          name: "test-dna",
          integrity: {
            zomes: [],
          },
          coordinator: {
            zomes: [],
          },
        },
        resources: new Map(),
      };

      const wasm = getFirstWasm(dnaBundle);

      expect(wasm).toBeNull();
    });
  });

  describe("extractZomeWasm", () => {
    it("should extract WASM from integrity zome", () => {
      const dnaBundle = {
        manifest: {
          manifest_version: "0" as const,
          name: "test-dna",
          integrity: {
            zomes: [
              { name: "zome1", path: "zome1.wasm", dependencies: [] },
              { name: "zome2", path: "zome2.wasm", dependencies: [] },
            ],
          },
          coordinator: {
            zomes: [],
          },
        },
        resources: new Map([
          ["zome1.wasm", new Uint8Array([1, 2])],
          ["zome2.wasm", new Uint8Array([3, 4])],
        ]),
      };

      const wasm = extractZomeWasm(dnaBundle, "zome2");

      expect(wasm).toEqual(new Uint8Array([3, 4]));
    });

    it("should extract WASM from coordinator zome", () => {
      const dnaBundle = {
        manifest: {
          manifest_version: "0" as const,
          name: "test-dna",
          integrity: {
            zomes: [{ name: "int_zome", path: "int.wasm", dependencies: [] }],
          },
          coordinator: {
            zomes: [{ name: "coord_zome", path: "coord.wasm", dependencies: [] }],
          },
        },
        resources: new Map([
          ["int.wasm", new Uint8Array([1, 2])],
          ["coord.wasm", new Uint8Array([3, 4])],
        ]),
      };

      const wasm = extractZomeWasm(dnaBundle, "coord_zome");

      expect(wasm).toEqual(new Uint8Array([3, 4]));
    });

    it("should return null for non-existent zome", () => {
      const dnaBundle = {
        manifest: {
          manifest_version: "0" as const,
          name: "test-dna",
          integrity: {
            zomes: [{ name: "zome1", path: "zome1.wasm", dependencies: [] }],
          },
          coordinator: {
            zomes: [],
          },
        },
        resources: new Map([["zome1.wasm", new Uint8Array([1, 2])]]),
      };

      const wasm = extractZomeWasm(dnaBundle, "non_existent");

      expect(wasm).toBeNull();
    });

    it("should return null if WASM resource is missing", () => {
      const dnaBundle = {
        manifest: {
          manifest_version: "0" as const,
          name: "test-dna",
          integrity: {
            zomes: [{ name: "test_zome", path: "missing.wasm", dependencies: [] }],
          },
          coordinator: {
            zomes: [],
          },
        },
        resources: new Map(), // Empty
      };

      const wasm = extractZomeWasm(dnaBundle, "test_zome");

      expect(wasm).toBeNull();
    });
  });

  describe("BundleError", () => {
    it("should create error with code and message", () => {
      const error = new BundleError("Test error", "TEST_CODE");

      expect(error.message).toBe("Test error");
      expect(error.code).toBe("TEST_CODE");
      expect(error.name).toBe("BundleError");
    });

    it("should include cause if provided", () => {
      const cause = new Error("Original error");
      const error = new BundleError("Wrapper error", "TEST_CODE", cause);

      expect(error.cause).toBe(cause);
    });
  });
});
