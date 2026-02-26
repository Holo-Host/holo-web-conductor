# Holo Web Conductor (HWC)

A browser extension-based Holochain conductor for zero-arc nodes. HWC runs Holochain applications directly in the browser without requiring a local Holochain installation, enabling lightweight participation in Holochain networks through a Chrome or Firefox extension.

HWC operates as a zero-arc node — it doesn't gossip or hold data for other nodes. Instead, it fetches all data from the network via a linker service, and stores agent keys locally using a Lair-like IndexedDB keystore. Web applications use `@holo-host/web-conductor-client`, a drop-in replacement for `@holochain/client` that communicates with the extension instead of a WebSocket conductor.

## Project Structure

```
packages/
├── extension/     # Chrome/Firefox browser extension (MV3)
├── core/          # Core conductor (WASM runtime, host functions, storage, DHT)
├── client/        # Client library (@holo-host/web-conductor-client)
├── lair/          # Browser-based Lair keystore (IndexedDB)
└── shared/        # Shared types and utilities
```

## Documentation
- [HOLOCHAIN_FOR_THE_WEB.md](./HOLOCHAIN_FOR_THE_WEB.md) — High level description and overview, minimally technical
- [ARCHITECTURE.md](./ARCHITECTURE.md) — System architecture, data flows, encoding boundaries, and design decisions
- [DEVELOPMENT.md](./DEVELOPMENT.md) — Build setup, dependencies, and development workflow
- [TESTING.md](./TESTING.md) — Testing guide (unit, integration, e2e with linker)

## License

Licensed under the [Cryptographic Autonomy License v1.0](./LICENSE) (CAL-1.0).
