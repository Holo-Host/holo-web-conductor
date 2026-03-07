# Holo Web Conductor (HWC)

A browser extension-based Holochain conductor for zero-arc nodes. HWC runs Holochain applications directly in the browser without requiring a local Holochain installation, enabling lightweight participation in Holochain networks through a Chrome or Firefox extension.

HWC operates as a zero-arc node — it doesn't gossip or hold data for other nodes. Instead, it fetches all data from the network via a linker service, and stores agent keys locally using a Lair-like IndexedDB keystore. Web applications use `@holo-host/web-conductor-client`, a drop-in replacement for `@holochain/client` that communicates with the extension instead of a WebSocket conductor.

## For hApp Developers

If you're building a Holochain application and want it to run via HWC:

- **[App Developer Guide](./APP_DEVELOPER_GUIDE.md)** — Integration guide: client setup, auth use cases, zero-arc behavior, API reference
- **[Deploying](./DEPLOYING.md)** — Infrastructure guide: what you need to run, environment matrix, production checklist
- **[Holochain for the Web](./HOLOCHAIN_FOR_THE_WEB.md)** — High-level vision, trust model, and why this architecture exists

## For HWC Contributors

If you're working on HWC itself:

- **[Contributing](./CONTRIBUTING.md)** — Project rules, coding standards, critical contracts
- **[Architecture](./ARCHITECTURE.md)** — Internal system architecture, data flows, encoding boundaries, design decisions
- **[Development](./DEVELOPMENT.md)** — Build setup, dependencies, development workflow
- **[Testing](./TESTING.md)** — Testing guide (unit, integration, e2e with linker)

## Project Structure

```
packages/
├── extension/     # Chrome/Firefox browser extension (MV3)
├── core/          # Core conductor (WASM runtime, host functions, storage, DHT)
├── client/        # Client library (@holo-host/web-conductor-client)
├── lair/          # Lair keystore (browser + Node.js, pluggable storage backend)
├── shared/        # Shared types and utilities
├── e2e/           # Playwright end-to-end tests
└── test-zome/     # HDK test zome (Rust/WASM)
```

## License

Licensed under the [Cryptographic Autonomy License v1.0](./LICENSE) (CAL-1.0).
