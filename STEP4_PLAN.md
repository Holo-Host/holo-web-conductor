    Step 4: hApp Context Creation - Implementation Plan

     Overview

     Create hApp contexts that associate web domains with DNA hashes, agent public keys, and installation metadata. This establishes the foundation for running hApp WASM in Step 5.

     Key Design Decisions:
     1. Storage: IndexedDB (fishy_happ_contexts) - for large DNA WASM storage and indexing
     2. Context Creation: Explicit INSTALL_HAPP message from web page
     3. Agent Keys: One agent key per domain (isolation by default)
     4. DNA Hash Source: From web page in INSTALL_HAPP message (validated later)

     ---
     Data Structures

     Core Types (packages/core/src/index.ts)

     /**
      * hApp context - associates a domain with DNAs and agent identity
      */
     export interface HappContext {
       id: string;                    // Unique context ID (UUID v4)
       domain: string;                // Domain (e.g., "https://example.com")
       agentPubKey: Uint8Array;       // Agent public key (Ed25519)
       agentKeyTag: string;           // Tag in Lair keystore
       dnas: DnaContext[];            // DNAs in this hApp
       appName?: string;              // App metadata
       appVersion?: string;
       installedAt: number;
       lastUsed: number;
       enabled: boolean;
     }

     export interface DnaContext {
       hash: Uint8Array;              // DNA hash (32 bytes)
       wasm: Uint8Array;              // WASM bytes (stored in IndexedDB)
       name?: string;                 // DNA name/identifier
       properties?: Record<string, unknown>;
     }

     export type CellId = [DnaHash, AgentPubKey]; // [DNA hash, Agent pub key]

     export interface InstallHappRequest {
       appName?: string;
       appVersion?: string;
       dnas: DnaConfig[];
     }

     IndexedDB Schema

     Database: fishy_happ_contexts v1

     Object Stores:

     1. contexts
       - Key path: id
       - Indexes: domain (unique), installedAt, lastUsed
     2. dna_wasm
       - Key path: hash (base64-encoded DNA hash)
       - Stores large WASM binaries separately for deduplication

     Rationale: IndexedDB chosen over chrome.storage.local for:
     - No quota issues with large WASM files
     - Better indexing and querying
     - Consistent with Lair keystore pattern

     ---
     Storage Architecture

     Context Storage Manager

     File: packages/extension/src/lib/happ-context-storage.ts

     export class HappContextStorage {
       private db: IDBDatabase | null = null;
       private ready: Promise<void>;

       // Context CRUD operations
       async putContext(context: HappContext): Promise<void>;
       async getContext(id: string): Promise<HappContext | null>;
       async getContextByDomain(domain: string): Promise<HappContext | null>;
       async listContexts(): Promise<HappContext[]>;
       async deleteContext(id: string): Promise<void>;
       async updateLastUsed(id: string): Promise<void>;

       // DNA WASM operations
       async putDnaWasm(hash: Uint8Array, wasm: Uint8Array): Promise<void>;
       async getDnaWasm(hash: Uint8Array): Promise<Uint8Array | null>;
       async deleteDnaWasm(hash: Uint8Array): Promise<void>;
     }

     export function getHappContextStorage(): HappContextStorage;

     Key Implementation:
     - Use toStorable()/fromStorable() pattern for Uint8Array serialization (follow Lair pattern)
     - Hash DNA WASM with blake2b before storing
     - Implement cleanup for orphaned DNA WASM

     ---
     Message Protocol

     New Message Types

     Add to packages/extension/src/lib/messaging.ts:

     export enum MessageType {
       // hApp Context Management
       INSTALL_HAPP = "install_happ",
       UNINSTALL_HAPP = "uninstall_happ",
       LIST_HAPPS = "list_happs",
       ENABLE_HAPP = "enable_happ",
       DISABLE_HAPP = "disable_happ",
     }

     Message Payloads

     export interface InstallHappPayload {
       appName?: string;
       appVersion?: string;
       dnas: {
         hash: Uint8Array;
         wasm: Uint8Array;
         name?: string;
         properties?: Record<string, unknown>;
       }[];
     }

     export interface InstallHappResponse {
       contextId: string;
       agentPubKey: Uint8Array;
       cells: CellId[];
     }

     export interface AppInfoResponse {
       contextId: string;
       domain: string;
       appName?: string;
       appVersion?: string;
       agentPubKey: Uint8Array;
       cells: CellId[];
       installedAt: number;
       enabled: boolean;
     }

     ---
     Context Manager

     Core Manager Class

     File: packages/extension/src/lib/happ-context-manager.ts

     export class HappContextManager {
       private storage: HappContextStorage;
       private lairClient: LairClient;
       private permissionManager: PermissionManager;

       async installHapp(domain: string, request: InstallHappRequest): Promise<HappContext>;
       async getContextForDomain(domain: string): Promise<HappContext | null>;
       async uninstallHapp(contextId: string): Promise<void>;
       async setContextEnabled(contextId: string, enabled: boolean): Promise<void>;
       async listContexts(): Promise<HappContext[]>;
       async touchContext(contextId: string): Promise<void>;
       getCellIds(context: HappContext): CellId[];
     }

     export function getHappContextManager(): HappContextManager;

     Install Flow Logic

     async installHapp(domain: string, request: InstallHappRequest): Promise<HappContext> {
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

       // 3. Generate context ID
       const contextId = crypto.randomUUID();

       // 4. Create agent key in Lair
       const agentKeyTag = `${domain}:agent`;
       const keyResult = await this.lairClient.newSeed(agentKeyTag, false);
       const agentPubKey = keyResult.entry_info.ed25519_pub_key;

       // 5. Store DNA WASM
       for (const dna of request.dnas) {
         await this.storage.putDnaWasm(dna.hash, dna.wasm);
       }

       // 6. Create and store context
       const context: HappContext = {
         id: contextId,
         domain,
         agentPubKey,
         agentKeyTag,
         dnas: request.dnas.map(d => ({ ...d })),
         appName: request.appName,
         appVersion: request.appVersion,
         installedAt: Date.now(),
         lastUsed: Date.now(),
         enabled: true,
       };

       await this.storage.putContext(context);
       return context;
     }

     Agent Key Tag Convention: ${domain}:agent
     - Example: https://example.com:agent
     - Isolates agent identity per domain
     - Future: Support multiple agents (:agent:0, :agent:1)

     ---
     Implementation Phases

     Phase 1: Core Storage

     Goal: Implement IndexedDB storage for contexts

     Tasks:
     1. Create happ-context-storage.ts with IndexedDB setup
     2. Implement serialization utilities
     3. Write storage tests (8-10 tests)
     4. Test create/read/update/delete operations
     5. Test domain indexing

     Files:
     - packages/extension/src/lib/happ-context-storage.ts (new, ~300 lines)
     - packages/extension/src/lib/happ-context-storage.test.ts (new, ~200 lines)

     Phase 2: Context Manager

     Goal: Implement business logic for context lifecycle

     Tasks:
     1. Create happ-context-manager.ts
     2. Implement install/uninstall logic
     3. Integrate with Lair for agent key creation
     4. Write manager tests (10-12 tests)
     5. Test permission checks

     Files:
     - packages/extension/src/lib/happ-context-manager.ts (new, ~350 lines)
     - packages/extension/src/lib/happ-context-manager.test.ts (new, ~250 lines)

     Phase 3: Message Handlers

     Goal: Wire up message protocol and background handlers

     Tasks:
     1. Add message types to messaging.ts
     2. Implement background handlers in background/index.ts
     3. Update inject script with new API methods
     4. Write integration tests
     5. Test end-to-end message flow

     Files:
     - packages/extension/src/lib/messaging.ts (modify)
     - packages/extension/src/background/index.ts (modify)
     - packages/extension/src/inject/index.ts (modify)
     - packages/core/src/index.ts (add types)

     Phase 4: UI & Testing

     Goal: Create management UI and comprehensive test page

     Tasks:
     1. Create hApp management UI in popup
     2. Build test webpage for install flow
     3. Manual browser testing
     4. Documentation updates

     Files:
     - packages/extension/src/popup/happs.html (new)
     - packages/extension/src/popup/happs.ts (new, ~200 lines)
     - packages/extension/test/happ-install-test.html (new)

     ---
     Key Technical Decisions

     1. Storage: IndexedDB vs chrome.storage.local

     Decision: IndexedDB

     Rationale:
     - chrome.storage.local has 10MB quota, insufficient for WASM files
     - IndexedDB supports indexing for fast domain lookups
     - Matches Lair keystore pattern
     - Can share DNA WASM across contexts (deduplication)

     2. Context Creation Timing

     Decision: Explicit INSTALL_HAPP message from web page

     Rationale:
     - Web page decides when to install (after user interaction)
     - Explicit install vs implicit on first zome call
     - Install message includes app name, version, DNAs
     - User knows what they're installing

     3. Agent Key Strategy

     Decision: One agent key per domain

     Rationale:
     - Each hApp has distinct identity (isolation)
     - Domain compromise doesn't affect other hApps
     - No key selection UI needed (simplicity)
     - Matches conductor behavior (per-app agents)

     4. DNA Hash Source

     Decision: Accept DNA hash from web page in INSTALL_HAPP message

     Rationale:
     - Web page knows its own DNAs
     - Supports dynamic hApp loading
     - Hash verification comes in Step 5 (WASM execution)

     Security Note: Step 5 will verify DNA hash matches WASM contents (Blake2b)

     ---
     Testing Strategy

     Unit Tests (~22 tests)

     Storage Tests (10 tests):
     - Create and retrieve context
     - Find context by domain
     - List all contexts
     - Update last used timestamp
     - Delete context
     - Store and retrieve DNA WASM
     - Handle missing context gracefully
     - IndexedDB upgrade handling
     - Domain index uniqueness
     - DNA WASM deduplication

     Manager Tests (12 tests):
     - Install hApp with new agent key
     - Reject install without permission
     - Reject duplicate install for same domain
     - Get context for domain
     - Uninstall hApp and delete agent key
     - Enable/disable context
     - List all contexts
     - Update last used on access
     - Return correct cell IDs
     - DNA WASM cleanup on uninstall
     - Agent key tag naming convention
     - Context ID generation (UUID)

     Manual Testing Checklist

     Install Flow:
     - Load extension and test page
     - First connection requires authorization
     - After approval, install hApp with DNAs
     - Verify context created in storage
     - Verify agent key created in Lair
     - Verify app info returns correct data
     - Reload page - app info still works
     - Browser restart - context persists

     Management Flow:
     - Open hApps management UI
     - See installed hApp listed
     - View agent pub key and cell IDs
     - Disable context - app info returns error
     - Re-enable context - app info works
     - Uninstall hApp
     - Verify cleanup (context, agent key, DNA WASM)

     ---
     Critical Files (Implementation Order)

     Phase 1 - Foundation:

     1. packages/core/src/index.ts (modify)
       - Add HappContext, DnaContext, CellId types
       - Add InstallHappRequest interface
     2. packages/extension/src/lib/happ-context-storage.ts (create)
       - ~300 lines
       - IndexedDB setup, CRUD operations
       - Uint8Array serialization
       - Domain indexing
     3. packages/extension/src/lib/happ-context-storage.test.ts (create)
       - ~200 lines
       - 10 storage tests

     Phase 2 - Business Logic:

     4. packages/extension/src/lib/happ-context-manager.ts (create)
       - ~350 lines
       - Install/uninstall logic
       - Lair integration
       - Permission checks
     5. packages/extension/src/lib/happ-context-manager.test.ts (create)
       - ~250 lines
       - 12 manager tests

     Phase 3 - Integration:

     6. packages/extension/src/lib/messaging.ts (modify)
       - Add 5 new message types
       - Add payload interfaces
     7. packages/extension/src/background/index.ts (modify)
       - Add handlers for INSTALL_HAPP, APP_INFO, etc.
       - Import and initialize HappContextManager
     8. packages/extension/src/inject/index.ts (modify)
       - Add installHapp() method to window.holochain API
       - Add getAppInfo() method

     Phase 4 - UI & Testing:

     9. packages/extension/src/popup/happs.html (create)
       - UI for viewing/managing installed hApps
     10. packages/extension/src/popup/happs.ts (create)
       - ~200 lines
       - hApp management logic
     11. packages/extension/test/happ-install-test.html (create)
       - Test page for install flow

     ---
     Integration with Existing Systems

     With Authorization (Step 3):

     - Permission check happens before install
     - After permission granted, web page can call installHapp()
     - Permission required: context install fails if not authorized

     With Lair Keystore (Step 2):

     - Generate new agent key via lair.newSeed()
     - Tag: ${domain}:agent
     - Store tag reference in context for signing operations

     With Background Service Worker:

     - Add context manager to background worker
     - New message handlers check permissions + context
     - Update APP_INFO to return context details

     ---
     Future Enhancements (Post-Step 4)

     1. Multiple Agents: Support :agent:0, :agent:1 for multiple identities per domain
     2. DNA Hash Verification: Verify DNA hash matches WASM in Step 5
     3. Context Migration: Handle schema upgrades in future versions
     4. Storage Quotas: Implement DNA WASM size limits and cleanup
     5. Context Export/Import: Backup and restore hApp installations
     6. Shared DNAs: Reference count DNA WASM for cleanup
