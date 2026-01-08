# Step 10.1: Fishy Integration for Ziptest
     
     ## Goal
     Create a `fishy` branch on ../ziptest that produces a single-page web app
     suitable for static hosting, connecting to the Fishy browser extension instead
     of a direct Holochain conductor.
     
     ## Overview
     
     The ziptest app currently uses `AppWebsocket.connect()` and `AdminWebsocket`
     from `@holochain/client`. We need to:
     1. Create a `FishyAppClient` that implements the `AppClient` interface
     2. Replace the connection logic in `App.svelte`
     3. Bundle the .happ file for installation
     4. Configure gateway URL (bundled for production, overridable for testing)
     
     ## Architecture Change
     
     ```
     Current:  App.svelte → AdminWebsocket → AppWebsocket → Conductor
     Target:   App.svelte → FishyAppClient → window.holochain → Extension → Gateway
     ```
     
     ## Implementation Steps
     
     ### Phase 1: Project Setup
     
     1. **Create branch** on ../ziptest:
        ```bash
        cd ../ziptest && git checkout -b fishy
        ```
     
     2. **Update `ui/vite.config.ts`**:
        - Add `base: './'` for relative paths (static hosting)
        - Add `__GATEWAY_URL__` define from env var
        - Ensure .happ is copied to dist
     
     3. **Copy happ to public**:
        ```bash
        cp workdir/ziptest.happ ui/public/ziptest.happ
        ```
     
     4. **Add type declarations** in `ui/src/vite-env.d.ts`:
        ```typescript
        declare const __GATEWAY_URL__: string;
        ```
     
     ### Phase 2: Create FishyAppClient
     
     **New file: `ui/src/fishy/FishyAppClient.ts`**
     
     Implements `AppClient` interface from `@holochain/client`:
     - `myPubKey: AgentPubKey` (property)
     - `installedAppId: InstalledAppId` (property)
     - `callZome(args)` - Forward to `window.holochain.callZome()`
     - `appInfo()` - Convert fishy format to standard `AppInfo` format
     - `on("signal", callback)` - Subscribe to signals
     
     Key methods:
     - `static connect(gatewayUrl)` - Factory that:
       1. Waits for fishy extension
       2. Calls `window.holochain.configureNetwork({ gatewayUrl })`
       3. Calls `window.holochain.connect()`
       4. Checks if hApp installed, installs if not (fetch `/ziptest.happ`)
       5. Sets up signal forwarding
     
     Critical: Must convert `appInfo()` response to standard format expected by
     `@holochain-open-dev/profiles`:
     ```typescript
     // Fishy returns: { contextId, agentPubKey, cells: [[dnaHash, agentKey]] }
     // Must return: { installed_app_id, agent_pub_key, cell_info: { role: [{
     provisioned: {...} }] } }
     ```
     
     ### Phase 3: Modify App.svelte
     
     **File: `ui/src/App.svelte`**
     
     Replace connection logic:
     ```svelte
     // Remove:
     import { AppWebsocket, AdminWebsocket } from "@holochain/client";
     import { WeaveClient, isWeaveContext } from "@theweave/api";
     
     // Add:
     import { FishyAppClient } from "./fishy/FishyAppClient";
     const GATEWAY_URL = __GATEWAY_URL__ || "http://localhost:8000";
     
     async function initialize() {
       // Wait for extension if not ready
       if (!window.holochain?.isFishy) {
         await waitForFishy(5000);
       }
     
       // Connect via Fishy
       client = await FishyAppClient.connect(GATEWAY_URL);
     
       // ProfilesClient works with FishyAppClient (implements AppClient)
       const profilesClient = new ProfilesClient(client, roleName);
       profilesStore = new ProfilesStore(profilesClient);
       connected = true;
     }
     ```
     
     Remove all Weave-specific code paths (`isWeaveContext()`, `WeaveClient`,
     `renderInfo` handling).
     
     ### Phase 4: Update store.ts
     
     **File: `ui/src/store.ts`**
     
     Make `weaveClient` optional:
     ```typescript
     constructor(
       public weaveClient: WeaveClient | null,  // Was required, now optional
       ...
     )
     ```
     
     ### Phase 5: Update Controller.svelte
     
     Make `weaveClient` prop optional (it's passed from App.svelte).
     
     ### Phase 6: Build Configuration
     
     **File: `ui/package.json`** - Add scripts:
     ```json
     {
       "scripts": {
         "build:fishy": "GATEWAY_URL=http://localhost:8000 vite build",
         "serve": "python3 -m http.server 8080 -d dist"
       }
     }
     ```
     
     ## Files to Create
     
     | File | Purpose |
     |------|---------|
     | `ui/src/fishy/FishyAppClient.ts` | AppClient implementation for fishy |
     | `ui/src/fishy/index.ts` | Module exports |
     | `ui/public/ziptest.happ` | Bundled hApp (copy from workdir) |
     
     ## Files to Modify
     
     | File | Changes |
     |------|---------|
     | `ui/vite.config.ts` | Add base path, GATEWAY_URL define |
     | `ui/src/vite-env.d.ts` | Add GATEWAY_URL type declaration |
     | `ui/src/App.svelte` | Replace connection with FishyAppClient |
     | `ui/src/store.ts` | Make weaveClient optional |
     | `ui/src/Controller.svelte` | Make weaveClient prop optional |
     | `ui/package.json` | Add build:fishy and serve scripts |
     
     ## Testing
     
     1. Build hApp: `npm run build:happ` (in ziptest root)
     2. Copy bundle: `cp workdir/ziptest.happ ui/public/`
     3. Build UI: `cd ui && npm run build:fishy`
     4. Start gateway: (run hc-http-gw pointing to conductor)
     5. Serve: `npm run serve`
     6. Load Fishy extension in browser
     7. Navigate to http://localhost:8080
     8. Test: authorization → install → create profile → use app
     
     ## Gateway URL Configuration
     
     - **Development**: `GATEWAY_URL=http://localhost:8000 npm run build:fishy`
     - **Production**: Set `GATEWAY_URL` env var at build time
     - **Override**: URL can also be passed to `FishyAppClient.connect()`
     
     ## Known Limitations
     
     1. No AdminWebsocket operations (key management internal to Fishy)
     2. No clone cell support
     3. No `dumpNetworkStats/Metrics` (return stubs)
     4. Single DNA only (no multi-role apps)
