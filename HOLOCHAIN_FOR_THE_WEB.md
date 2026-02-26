# Holochain for the Web: The HWC + Linker Architecture

## The Problem

Holochain applications are peer-to-peer. Every participant runs a **conductor** — software that manages their identity, keys, executes application logic, stores their data, and communicates with the network. This is powerful for sovereignty, but it means users must install and run software to participate. That's a non-starter for casual web users who expect to open a URL and start using an app.

The question is: can we bring Holochain apps to the browser without giving up the things that ensure application integrity and make Holochain powerful?

## Two Jobs, One Conductor

A standard Holochain conductor does two fundamentally different jobs:

1. **Agent-side work** — managing your identity (keypair), signing your actions, running the application's logic (WASM zomes), and maintaining your personal history (source chain). This is *yours*. It's private, it's sovereign, and it must stay under your control.

2. **Network-side work** — participating in the DHT: publishing your shared data, storing data and answering queries on behalf of other peers, gossiping to keep the shared data store (distributed hash table) healthy, and routing signals between peers. This is *communal*. It works best with an always-on connection, significant bandwidth, and storage capacity.

The key insight of this architecture is that **these two jobs can be separated**. A user's browser can handle all of job #1 — it has the CPU to run WASM, it can store keys securely, and it can sign actions. But it can't do job #2 — browsers go to sleep, lose connectivity, and shouldn't be responsible for storing and serving other people's data.

## The Split

**The Holo Web Conductor (HWC)** is a browser extension that handles the agent side. When you visit a Holochain-powered website, the extension:

- Generates and stores your cryptographic keys locally (they never leave your browser)
- Runs the application's compiled logic (WASM) in a sandboxed environment
- Signs every action you take with your private key
- Maintains your source chain for the session

From the application's perspective, it looks like a normal Holochain conductor. The app's JavaScript calls `callZome()` the same way it would against a local conductor. The extension is a drop-in replacement.

**The Linker** handles the network side. It's a lightweight server that sits between browsers and the Holochain DHT network. When your browser extension needs to read data or publish a new action:

- It sends the request to the Linker over a standard web connection
- The Linker queries the DHT network on your behalf
- Results come back to your browser
- When you create new data, the Linker publishes your signed actions to the appropriate DHT authorities

The Holo Web Conductor is a **zero-arc node**, with the Linker connecting it  just enough to send and receive messages, but it doesn't store DHT data or take on validation responsibilities.

## What Stays Decentralized, What Doesn't

**Fully decentralized (in the browser):**
- Key generation and storage
- Action signing (your private key never leaves your device)
- Application logic execution (WASM runs locally)
- Data authorship (you create and sign your own chain entries)

**Semi-centralized (infrastructure services):**
- **Linker** — proxies your DHT queries and publishes your signed actions. It can see *what* you're querying (though not decrypt encrypted entries). Multiple Linkers can exist; you're not locked to one.
- **HTTP Gateway** — provides read-only access to the DHT for users who haven't joined yet. Lets people browse content before committing to install the extension.
- **Joining Service** — handles user onboarding: identity verification (email, wallet signature, invite codes), and hands out the connection details (which Linker to use, which app bundle to install, any required membership proofs).

**Partially built, needs update:**
- **Chain Head Coordinator (CHC)** — When the same person uses the same keys across multiple devices (or multiple browser profiles), their source chains can diverge. The CHC provides a lightweight consensus mechanism so that two devices running the same agency can coordinate who gets to commit next, preventing chain forks. This is a synchronization service, not a data store — it coordinates ordering, not content.

## The Trust Model

The semi-centralized components are designed so that **trust requirements are minimal and auditable**:

- The Linker never holds your private keys. When the network needs a signature from you (for peer authentication), the Linker sends the signing request to your browser, your extension signs it locally, and sends back only the signature.
- The Linker cannot forge actions on your behalf. Every action in Holochain is signed, and validators on the DHT verify signatures independently.
- The Joining Service issues membership proofs, but these are validated by the application's own DNA logic — the service can't grant access that the P2P application doesn't recognize.
- The HTTP Gateway is read-only. It can serve public data but cannot modify anything.

The worst a compromised Linker can do is refuse to relay your requests (denial of service) or observe your query patterns (metadata exposure). It cannot tamper with data, impersonate you, or access your private keys. And because the Linker protocol is standardized, you can switch to a different one.

## The Onboarding Flow

From a user's perspective:

1. You visit a website that runs on Holochain
2. The site detects whether you have the HWC extension installed
3. If you don't have it, you're offered read-only access through the HTTP Gateway — you can browse content but not create anything
4. When you decide to make write actions, you have to upgrade your local agency in the browser.  The Joining Service walks you through verification (as simple as "open join" with no requirements, or as involved as email verification or wallet signature, depending on what the app requires)
5. The Joining Service hands your browser the connection details: which Linker to use, the app bundle to install, and any membership credentials
6. The extension installs the app, connects to the Linker, and you're participating in the Holochain network — signing actions, reading data, the full experience — all from a browser tab

## Provisioning: How App Developers Get Infrastructure

This is the practical question. An application developer who builds a Holochain hApp and wants it accessible on the web may need infrastructure: 
1. A Linker or pool of linkers 
2. An HTTP Gateway, only if read-access to browsers is public
3. A Joining Service, if write-access to the app is gated.
4. In the future: Chain-head-coordinators.

There are several models for how these may be provisioned, and may involve payment with ready integrations via [Unyt Accounting](https://unyt.co):

**Self-hosted:** The developer runs their own Linker and Joining Service. This gives full control but requires operational expertise and ongoing infrastructure costs. Suitable for organizations with DevOps capacity.

**Hosted service pools:** A provider (like Holo) operates pools of Linkers and HTTP Gateways across regions. App developers register their hApp with the provider, configure their Joining Service (or use a hosted one), and get assigned Linker capacity from the pool. The provider handles scaling, uptime, and geographic distribution. The Joining Service's `linker_info` field supports both "assigned" mode (the service picks the best Linker for the user) and "client choice" mode (the user picks from available options, potentially optimizing for latency by region).

**Federated/community pools:** Multiple organizations contribute Linker capacity to a shared pool. An application's Joining Service can draw from any participating provider. This distributes the infrastructure dependency across multiple parties — no single provider becomes a chokepoint.

**Hybrid:** An app developer runs their own Joining Service (to control onboarding policy and identity verification) but points users to Linkers from a hosted pool. This separates the policy decision (who can join) from the infrastructure question (where do they connect).

The Joining Service design is intentionally modular here. It advertises available Linkers and Gateways, supports region hints for latency optimization, and allows the selection mode to be configured per-app. A developer who starts with self-hosted infrastructure can later migrate to a pool (or vice versa) by updating their Joining Service configuration — no change to the client code or user experience.

## Why This Approach

The conventional path to "Holochain on the web" might be to run full conductors in the cloud and have browsers talk to them via API. That works, but it recreates the client-server model that Holochain was designed to replace. Your keys live on someone else's server. Your data is processed on someone else's machine. You're trusting the infrastructure operator not just with availability, but with your identity.

The HWC + Linker approach preserves the parts of Holochain's sovereignty model that matter most — key custody, local signing, local execution of application logic — while pragmatically delegating the parts that browsers genuinely can't do — network participation, DHT storage, always-on availability.

The semi-centralized components are designed to be **replaceable, auditable, and minimal in trust surface**. They're infrastructure, not custodians.

