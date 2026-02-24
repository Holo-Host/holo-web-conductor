# Compatibility

This table tracks which versions of the Holo Web Conductor extension are compatible with which versions of the h2hc-linker.

| HWC Version | h2hc-linker Version | Notes |
|-------------|---------------------|-------|
| v0.1.0      | v0.1.0              | Initial release |

## Release Process

- **Independent releases**: Most extension updates don't require a linker update. Tag and release each repo independently.
- **Lock-step releases**: When a protocol or API change affects both, tag both repos with the same version and update this table.
- **Triggering a release**: Push a tag matching `v*` (e.g., `git tag v0.1.0 && git push origin v0.1.0`).
