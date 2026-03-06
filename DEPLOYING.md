# Deploying an HWC-Compatible hApp

This guide covers what infrastructure you need to run a Holochain application via HWC in production.

---

## Components

An HWC deployment has up to four components:

```
User's Browser                          Your Infrastructure
┌──────────────────┐                    ┌──────────────────────────┐
│  Your Web App    │                    │  Joining Service         │
│  + HWC Extension │◄──────────────────►│  (agent onboarding)      │
│                  │                    └──────────────────────────┘
│                  │                    ┌──────────────────────────┐
│                  │◄═══════════════════►│  Linker (h2hc-linker)    │
│                  │  WebSocket relay    │  (network relay)         │
│                  │                    └───────────┬──────────────┘
└──────────────────┘                                │
                                        ┌───────────▼──────────────┐
                                        │  Holochain Network       │
                                        │  (always-on conductors)  │
                                        └──────────────────────────┘
```

| Component | What it does | Required? |
|-----------|-------------|-----------|
| **Web App** | Your hApp UI, served as a static site | Yes |
| **Linker** | Relays data between browser and Holochain network | Yes |
| **Joining Service** | Onboards agents (identity verification, membrane proofs, linker URLs) | Recommended |
| **Holochain Conductors** | Always-on nodes that hold the DHT | Yes (existing network) |
| **hApp Bundle** | Your `.happ` file, hosted at a URL | Yes |

---

## Environment Matrix

| Environment | Joining Service | Linker | Holochain | Notes |
|-------------|----------------|--------|-----------|-------|
| **Local dev** | `npm run dev` on localhost | Local h2hc-linker | `hc sandbox` | Everything on one machine |
| **Staging** | Node.js on VPS, `auth: ["open"]` | Staging linker | Test conductors | No real auth |
| **Production** | Cloudflare Worker or VPS | Production linker(s) | Production network | Real auth, TLS, monitoring |

---

## Step-by-Step: Production Deployment

### 1. Deploy Holochain conductors

You need at least one always-on Holochain conductor running your hApp's DNA, and another node that was on at least once for the nodes to come up to full sync. These are the "full nodes" that hold DHT data and gossip with each other. HWC browser nodes are zero-arc — they don't hold data for others.

### 2. Deploy the linker

The [h2hc-linker](https://github.com/Holo-Host/h2hc-linker) bridges between browser extensions and the Holochain network. See the linker's own documentation for deployment instructions.

You'll need the linker's WebSocket URL (e.g., `wss://linker.example.com:8090`) for the joining service and client configuration.

### 3. Deploy the joining service

See the [joining-service DEPLOYMENT.md](https://github.com/Holo-Host/joining-service/blob/main/DEPLOYMENT.md) for full deployment instructions. Three deployment targets are supported:

| Target | Best for |
|--------|----------|
| Local Node.js | Development, testing |
| Cloudflare Workers | Production edge deployment, low ops overhead |
| Linux VPS (systemd + nginx) | Self-hosted production |

Key configuration decisions:
- **Auth methods**: What verification do you require? See [APP_DEVELOPER_GUIDE.md](./APP_DEVELOPER_GUIDE.md#authentication-use-cases) for the options.
- **Membrane proofs**: If your DNA has a `genesis_self_check` that validates a progenitor signature, you need to configure the signing key. See the joining-service docs for the key generation workflow.
- **Session storage**: Memory (dev only), SQLite (VPS), or Cloudflare KV (Workers).

### 4. Host the hApp bundle

Your `.happ` file needs to be accessible via HTTP(S). Options:
- Same static server as your UI (e.g., `https://myapp.example.com/app.happ`)
- CDN or object storage (S3, R2, etc.)
- Configured as `happ_bundle_url` in the joining service config

### 5. Configure auto-discovery (optional)

Serve a `.well-known/holo-joining` JSON file from your app's domain so clients can auto-discover the joining service:

```json
{
  "joining_service_url": "https://joining.example.com"
}
```

This enables `autoDiscover: true` in the client, eliminating hardcoded URLs.

If the joining service runs on the same domain as your app, its built-in handler covers this automatically.

### 6. Deploy the web app

Serve your hApp UI as a static site. The UI includes `@holo-host/web-conductor-client` and is configured with:
- Linker URL (via build-time injection or auto-discovery)
- Joining service URL (via build-time injection or auto-discovery)
- `onChallenge` callback (if using interactive auth)

See [APP_DEVELOPER_GUIDE.md](./APP_DEVELOPER_GUIDE.md) for the client integration code.

---

## Local Development Setup

For local development, you need to run all components locally:

```bash
# Terminal 1: Holochain sandbox
hc sandbox generate --num-sandboxes 2 workdir
hc sandbox run --all

# Terminal 2: Linker
cd ../h2hc-linker
cargo run

# Terminal 3: Joining service (optional)
cd ../joining-service
echo '{"happ":{"id":"my-happ","name":"My hApp"},"auth_methods":["open"],"linker_urls":["ws://localhost:8090"]}' > config.json
npm run dev

# Terminal 4: Your app UI
cd my-app/ui
LINKER_URL=ws://localhost:8090 JOINING_SERVICE_URL=http://localhost:3000 npm run dev
```

Load the HWC extension in Chrome (`chrome://extensions/` → Load unpacked), then navigate to your app.

---

## Checklist

Before going live:

- [ ] Holochain conductors running with your DNA
- [ ] Linker deployed and reachable via WSS
- [ ] Joining service deployed with correct auth methods
- [ ] If using membrane proofs: signing key matches DNA progenitor
- [ ] hApp bundle hosted at a stable URL
- [ ] Web app configured with correct URLs (or auto-discovery)
- [ ] TLS on all public endpoints
- [ ] `.well-known/holo-joining` served from app domain (if using auto-discovery)
- [ ] Test the full flow: install extension → load app → join → make a zome call
