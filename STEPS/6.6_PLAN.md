# Step 6.6: Automated Integration Testing Plan

## Goal
Eliminate the manual testing loop (reload extension → reload page → reconnect → click buttons → copy console output) by creating automated integration tests that simulate the full web page ↔ extension ↔ WASM flow, allowing Claude to see results directly and iterate on fixes automatically.

## Current State

### What Exists
- **15 unit test suites** across packages (55 passing tests)
- **1 integration test suite** (`integration.test.ts`) - currently **SKIPPED** due to historical serialization issues
- **Manual test page** (`wasm-test.html`) with 19 interactive test buttons
- **19 test zome functions** in `packages/test-zome/src/lib.rs`
- **Vitest framework** with jsdom, fake-indexeddb, mocked Chrome APIs
- **Message-based architecture** that's fully mockable

### Pain Points
1. **Manual Testing Loop**: After each fix, must:
   - Rebuild extension (`npm run build`)
   - Reload extension in browser
   - Reload test page
   - Reconnect session (CONNECT message)
   - Click test buttons manually
   - Copy console output back to Claude
   - Repeat for each failing test

2. **Integration Tests Disabled**: The `integration.test.ts` file has 15 test suites but is marked `describe.skip` due to past serialization issues that are now resolved (Step 6 complete)

3. **Limited Visibility**: Claude cannot see test results directly - requires user to manually copy console logs

4. **Incomplete Coverage**: No automated tests for:
   - Full CONNECT → INSTALL_HAPP → CALL_ZOME flow
   - Storage persistence across multiple calls
   - Atomic operations and rollback scenarios
   - Link queries with complex filters

## Canonical Reference Source

**CRITICAL**: When looking up Holochain data structures, serialization formats, or host function signatures, **ALWAYS** use:
- **Primary source**: `../holochain/` (Holochain 0.6 repository)
  - Action types: `../holochain/crates/holochain_integrity_types/src/action/`
  - Entry types: `../holochain/crates/holochain_integrity_types/src/entry/`
  - Link types: `../holochain/crates/holochain_zome_types/src/link.rs`
  - Host function I/O: `../holochain/crates/holochain/src/core/ribosome/host_fn/`
  - Serialization: `../holochain/crates/holochain_serialized_bytes/`

**DO NOT**:
- Search the web for Holochain formats
- Use .cargo registry files (may be outdated or wrong version)
- Guess data structures based on names

**Rationale**: Most current issues are wrong object formats (missing fields, wrong types, incorrect nesting). The ../holochain repo has the exact correct formats for Holochain 0.6.

---

## Solution: Three-Tier Automated Testing Strategy

### Tier 1: Re-enable & Expand Integration Tests (Node-based)
**Goal**: Automated tests that run in CI without browser, simulating full extension flow

**Approach**:
- Re-enable `packages/core/src/ribosome/integration.test.ts`
- Mock the extension message layer (no real Chrome extension)
- Use real WASM, real storage (fake-indexeddb), real serialization
- Test the full flow: serialize → execute WASM → deserialize → validate

**Coverage**:
- All 19 zome functions from test-zome
- Entry CRUD with storage persistence verification
- Link operations with query filters
- Atomic operations and rollback scenarios
- Signal emission and collection
- Chain head tracking across calls

**Benefits**:
- Runs in CI (no browser needed)
- Fast execution (~1-2 seconds per suite)
- Claude sees results directly via test output
- Automatic on every code change

---

### Tier 2: Test Harness for Development Workflow
**Goal**: Eliminate manual reload/reconnect loop during development

**Approach**:
- Create `packages/core/src/ribosome/test-harness.ts`
- Simulates the full message flow without browser:
  ```
  Test Script → Mock Extension → Ribosome → Storage → WASM
  ```
- Provides helper functions:
  - `createTestSession()` - Initialize extension state
  - `installTestHapp()` - Load test.happ bundle
  - `callTestZome(fn, payload)` - Execute zome function
  - `assertResult(result, expected)` - Validate output
  - `resetStorage()` - Clear between tests

**Example Usage**:
```typescript
describe("Entry CRUD flow", () => {
  let session: TestSession;

  beforeEach(async () => {
    session = await createTestSession();
    await session.installTestHapp();
  });

  it("should create, get, update, delete entry", async () => {
    // Create
    const createResult = await session.callZome("create_test_entry", "test content");
    expect(createResult.Ok).toBeDefined();
    const actionHash = createResult.Ok;

    // Get
    const getResult = await session.callZome("get_test_entry", actionHash);
    expect(getResult.Ok.entry.content).toBe("test content");

    // Update
    const updateResult = await session.callZome("update_test_entry", {
      original_action_address: actionHash,
      new_content: "updated content"
    });
    expect(updateResult.Ok).toBeDefined();

    // Delete
    const deleteResult = await session.callZome("delete_test_entry", actionHash);
    expect(deleteResult.Ok).toBeDefined();

    // Verify chain head advanced by 4 (create, get doesn't advance, update, delete)
    const agentInfo = await session.callZome("get_agent_info", null);
    expect(agentInfo.Ok.chain_head.action_seq).toBe(6); // 3 genesis + 3 new actions
  });
});
```

**Benefits**:
- No browser reload needed
- No manual clicking
- Claude sees full test output
- Can iterate on fixes in tight loop
- Tests run in <100ms each

---

### Tier 3: Optional Browser Automation (Playwright)
**Goal**: Test real extension in real browser for edge cases

**Approach**:
- Add Playwright as dev dependency
- Create `packages/extension/test/playwright/` directory
- Write browser automation scripts that:
  - Load unpacked extension
  - Navigate to test page
  - Execute button clicks programmatically
  - Assert DOM state and console logs
  - Screenshot failures

**When to Use**:
- Testing Chrome extension APIs that can't be mocked
- Verifying UI behavior (popup, authorization flow)
- End-to-end integration with real browser
- Debugging issues that only appear in browser

**Benefits**:
- Real browser environment
- Can test extension UI
- Automated screenshot capture
- Still no manual clicking

**Deferred**: Implement only if Tier 1 & 2 don't catch all issues

---

## Implementation Plan

### Phase 1: Re-enable Integration Tests (Priority 1)

**Task 1.1: Fix integration.test.ts**
- Remove `describe.skip` wrapper
- Update test setup to use current storage layer
- Fix any serialization issues discovered
- Ensure all 15 test suites pass

**Files**:
- `packages/core/src/ribosome/integration.test.ts` (modify)

**Success Criteria**:
- All 15 integration test suites passing
- Tests run in CI without manual intervention
- Output shows clear pass/fail for each zome function

---

**Task 1.2: Add Missing Test Coverage**

Add tests for functionality not in integration.test.ts:

1. **Storage Persistence Tests**:
   - Create entry → restart session → retrieve entry
   - Create link → restart session → query links
   - Verify chain head persists across restarts

2. **Atomic Operation Tests**:
   - `create_entry_with_link` - both succeed or both fail
   - `create_entry_then_fail` - verify chain unchanged on rollback
   - Multiple operations in single zome call

3. **Link Query Tests**:
   - Filter by link_type
   - Filter by tag_prefix
   - Count links with filters
   - Delete link and verify removed from queries

4. **Complex Data Structure Tests**:
   - Nested objects in entry content
   - Arrays of links
   - Multiple entry types
   - Query with filters

**Files**:
- `packages/core/src/ribosome/integration.test.ts` (add suites)

**Success Criteria**:
- 30+ integration tests covering all major flows
- Tests validate storage state directly
- Clear error messages on failure

---

### Phase 2: Test Harness for Development (Priority 2)

**Task 2.1: Create Test Harness**

Build helper utilities for simulating extension flow:

**File**: `packages/core/src/ribosome/test-harness.ts`

```typescript
/**
 * Test Harness for Extension Flow Simulation
 *
 * Eliminates manual browser testing by simulating:
 * - Extension background script state
 * - Message passing (CONNECT, INSTALL_HAPP, CALL_ZOME)
 * - Storage initialization
 * - WASM execution
 */

export interface TestSession {
  contextId: string;
  cellId: [Uint8Array, Uint8Array];

  // Core operations
  installHapp(happPath: string): Promise<void>;
  callZome(fn: string, payload: any): Promise<any>;

  // State inspection
  getChainHead(): Promise<{ action_seq: number; hash: Uint8Array }>;
  getStoredActions(): Promise<Action[]>;
  getStoredEntries(): Promise<StoredEntry[]>;
  getStoredLinks(): Promise<Link[]>;

  // Cleanup
  reset(): Promise<void>;
}

export async function createTestSession(options?: {
  dnaHash?: Uint8Array;
  agentPubKey?: Uint8Array;
}): Promise<TestSession> {
  // Initialize storage with fresh IndexedDB
  // Load test.happ bundle
  // Create cell ID
  // Return session interface
}

// Helper assertions
export function assertActionHash(hash: any): void {
  expect(hash).toBeInstanceOf(Uint8Array);
  expect(hash.length).toBe(39);
  expect(hash[0]).toBe(0x84); // Action hash prefix
  expect(hash[1]).toBe(0x29);
  expect(hash[2]).toBe(0x24);
}

export function assertEntryHash(hash: any): void {
  expect(hash).toBeInstanceOf(Uint8Array);
  expect(hash.length).toBe(39);
  expect(hash[0]).toBe(0x84); // Entry hash prefix
  expect(hash[1]).toBe(0x21);
  expect(hash[2]).toBe(0x24);
}

export function assertOkResult<T>(result: any): T {
  expect(result).toHaveProperty("Ok");
  return result.Ok;
}

export function assertErrResult(result: any): any {
  expect(result).toHaveProperty("Err");
  return result.Err;
}
```

**Files Created**:
- `packages/core/src/ribosome/test-harness.ts` (~200 lines)
- `packages/core/src/ribosome/test-harness.test.ts` (~100 lines - tests the harness itself)

**Success Criteria**:
- Test harness can execute all 19 zome functions
- State inspection works (can read chain head, actions, entries, links)
- Reset properly clears storage
- Tests run in <100ms each

---

**Task 2.2: Convert Manual Tests to Automated**

Convert each button test from `wasm-test.html` into an automated test:

**File**: `packages/core/src/ribosome/automated-tests.test.ts`

```typescript
describe("Automated Tests (formerly manual)", () => {
  let session: TestSession;

  beforeEach(async () => {
    session = await createTestSession();
    await session.installHapp("../../../extension/test/test.happ");
  });

  describe("Info Functions", () => {
    it("should get agent info", async () => {
      const result = await session.callZome("get_agent_info", null);
      const info = assertOkResult(result);

      expect(info.agent_initial_pubkey).toBeInstanceOf(Uint8Array);
      expect(info.agent_latest_pubkey).toBeInstanceOf(Uint8Array);
      expect(info.chain_head.action_seq).toBeGreaterThanOrEqual(3);
    });

    it("should get zome info", async () => {
      const result = await session.callZome("get_zome_info", null);
      const info = assertOkResult(result);

      expect(info.name).toBe("test_zome");
      expect(info.properties).toBeDefined();
    });
  });

  describe("Entry CRUD", () => {
    it("should create and retrieve entry", async () => {
      const createResult = await session.callZome("create_test_entry", "my content");
      const actionHash = assertOkResult(createResult);
      assertActionHash(actionHash);

      const getResult = await session.callZome("get_test_entry", actionHash);
      const record = assertOkResult(getResult);

      expect(record.entry.content).toBe("my content");
      expect(record.signed_action.hashed.content.type).toBe("Create");
    });

    it("should update entry", async () => {
      const createHash = assertOkResult(await session.callZome("create_test_entry", "original"));

      const updateResult = await session.callZome("update_test_entry", {
        original_action_address: createHash,
        new_content: "updated"
      });
      const updateHash = assertOkResult(updateResult);

      const getResult = await session.callZome("get_test_entry", updateHash);
      const record = assertOkResult(getResult);
      expect(record.entry.content).toBe("updated");
    });

    it("should delete entry", async () => {
      const createHash = assertOkResult(await session.callZome("create_test_entry", "to delete"));

      const deleteResult = await session.callZome("delete_test_entry", createHash);
      assertOkResult(deleteResult);

      // Verify entry is marked as deleted in details
      const detailsResult = await session.callZome("get_details_test", createHash);
      const details = assertOkResult(detailsResult);
      expect(details.deletes.length).toBe(1);
    });
  });

  describe("Links", () => {
    it("should create and retrieve links", async () => {
      const baseHash = assertOkResult(await session.callZome("create_test_entry", "base"));
      const targetHash = assertOkResult(await session.callZome("create_test_entry", "target"));

      const linkResult = await session.callZome("create_test_link", {
        base_address: baseHash,
        target_address: targetHash,
        tag: new Uint8Array([1, 2, 3])
      });
      assertOkResult(linkResult);

      const getLinksResult = await session.callZome("get_test_links", baseHash);
      const links = assertOkResult(getLinksResult);

      expect(links.length).toBe(1);
      expect(links[0].target).toEqual(targetHash);
      expect(links[0].tag).toEqual(new Uint8Array([1, 2, 3]));
    });

    it("should delete link", async () => {
      const baseHash = assertOkResult(await session.callZome("create_test_entry", "base"));
      const targetHash = assertOkResult(await session.callZome("create_test_entry", "target"));

      const linkHash = assertOkResult(await session.callZome("create_test_link", {
        base_address: baseHash,
        target_address: targetHash
      }));

      await session.callZome("delete_test_link", linkHash);

      const getLinksResult = await session.callZome("get_test_links", baseHash);
      const links = assertOkResult(getLinksResult);
      expect(links.length).toBe(0); // Deleted links filtered out
    });
  });

  describe("Atomic Operations", () => {
    it("should create entry and link atomically", async () => {
      const targetHash = assertOkResult(await session.callZome("create_test_entry", "target"));

      const beforeSeq = (await session.getChainHead()).action_seq;

      const result = await session.callZome("create_entry_with_link", targetHash);
      const [entryHash, linkHash] = assertOkResult(result);

      const afterSeq = (await session.getChainHead()).action_seq;
      expect(afterSeq).toBe(beforeSeq + 2); // Both operations committed

      // Verify both exist
      const entry = assertOkResult(await session.callZome("get_test_entry", entryHash));
      expect(entry).toBeDefined();

      const links = assertOkResult(await session.callZome("get_test_links", entryHash));
      expect(links.length).toBe(1);
    });

    it("should rollback on failure", async () => {
      const beforeSeq = (await session.getChainHead()).action_seq;

      const result = await session.callZome("create_entry_then_fail", null);
      assertErrResult(result); // Should fail

      const afterSeq = (await session.getChainHead()).action_seq;
      expect(afterSeq).toBe(beforeSeq); // Chain unchanged
    });
  });

  describe("Storage Persistence", () => {
    it("should persist across session restart", async () => {
      const hash = assertOkResult(await session.callZome("create_test_entry", "persistent"));

      // Reset and recreate session
      await session.reset();
      session = await createTestSession({
        dnaHash: session.cellId[0],
        agentPubKey: session.cellId[1]
      });
      await session.installHapp("../../../extension/test/test.happ");

      // Entry should still exist
      const result = await session.callZome("get_test_entry", hash);
      const record = assertOkResult(result);
      expect(record.entry.content).toBe("persistent");
    });
  });
});
```

**Files Created**:
- `packages/core/src/ribosome/automated-tests.test.ts` (~400 lines)

**Success Criteria**:
- All 19 zome functions tested
- Tests cover happy path and error cases
- Storage persistence verified
- Tests run in <5 seconds total

---

### Phase 3: Developer Workflow Integration (Priority 3)

**Task 3.1: Watch Mode Test Runner**

Create npm script for continuous testing during development:

**File**: `package.json` (root)

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:integration": "vitest run packages/core/src/ribosome/integration.test.ts",
    "test:automated": "vitest run packages/core/src/ribosome/automated-tests.test.ts",
    "test:ribosome": "vitest run packages/core/src/ribosome/",
    "test:dev": "vitest --reporter=verbose packages/core/src/ribosome/"
  }
}
```

**Workflow**:
1. Terminal 1: `npm run test:dev` (watch mode)
2. Make code changes in editor
3. Tests re-run automatically
4. See results instantly in terminal
5. Fix issues and repeat

**Success Criteria**:
- Tests re-run on file save (<1 second)
- Clear output shows which tests passed/failed
- Error messages include file:line references
- No manual browser interaction needed

---

**Task 3.2: CI Integration**

Add integration tests to GitHub Actions (if applicable):

**File**: `.github/workflows/test.yml`

```yaml
name: Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
      - run: npm install
      - run: npm run build
      - run: npm run test:integration
      - run: npm run test:automated
```

**Success Criteria**:
- Tests run on every commit
- PR checks show test status
- Failures block merges

---

### Phase 4: Optional Browser Automation (Priority 4 - DEFERRED)

Only implement if Phases 1-3 don't catch all issues.

**Task 4.1: Add Playwright**

```bash
npm install -D @playwright/test
npx playwright install chromium
```

**Task 4.2: Extension Loading Test**

**File**: `packages/extension/test/playwright/extension.spec.ts`

```typescript
import { test, expect, chromium } from '@playwright/test';
import path from 'path';

test('should load extension and run tests', async () => {
  const extensionPath = path.join(__dirname, '../../dist');

  const browser = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  });

  const page = await browser.newPage();
  await page.goto('http://localhost:8080/wasm-test.html');

  // Wait for extension injection
  await page.waitForFunction(() => window.holochain !== undefined);

  // Click "Check Extension" button
  await page.click('#check-extension');

  // Assert status shows "Connected"
  const status = await page.textContent('#extension-status');
  expect(status).toContain('Connected');

  // Run automated test sequence
  await page.click('#install-happ');
  await page.waitForTimeout(1000);

  await page.click('#test-create-entry');
  const result = await page.textContent('#console-output');
  expect(result).toContain('"Ok"');

  await browser.close();
});
```

**Deferred Rationale**:
- Playwright adds complexity and test time
- Most issues are logic/serialization, not browser-specific
- Tiers 1 & 2 should catch 95%+ of issues
- Can add later if needed

---

## Success Metrics

### Quantitative
- **Test Count**: Increase from 55 unit tests to 85+ tests (30 new integration tests)
- **Coverage**: All 19 zome functions tested automatically
- **Speed**: Integration test suite runs in <5 seconds
- **Manual Testing**: Reduced from 100% to <5% (only for new UI features)

### Qualitative
- **Claude Visibility**: Can see all test results directly via `vitest run` output
- **Iteration Speed**: Fix → Test cycle from 2 minutes to <10 seconds
- **Reliability**: Tests deterministic (no flaky failures from browser timing)
- **Debugging**: Clear error messages point to exact issue (wrong field, missing data, bad format)

---

## Implementation Order

1. **Week 1: Re-enable Integration Tests** (Phase 1)
   - Remove `describe.skip`
   - Fix any serialization issues
   - Add missing test coverage
   - **Milestone**: All integration tests passing in CI

2. **Week 2: Test Harness** (Phase 2)
   - Build test-harness.ts
   - Convert manual tests to automated
   - **Milestone**: Can run all 19 tests without browser

3. **Week 3: Developer Workflow** (Phase 3)
   - Add watch mode scripts
   - Integrate with CI
   - **Milestone**: Tests run automatically on save

4. **Future: Browser Automation** (Phase 4 - only if needed)
   - Add Playwright
   - Build extension loading tests
   - **Milestone**: Full E2E coverage

---

## Risk Mitigation

### Risk: Integration tests still fail after re-enabling
**Mitigation**:
- Use test harness to debug in isolation
- Add detailed logging for serialization
- Compare byte-by-byte with ../holochain reference implementation

### Risk: Tests are slow (>10 seconds)
**Mitigation**:
- Use session caching (don't reinstall hApp for every test)
- Run tests in parallel with `vitest --pool=threads`
- Mock heavy operations (WASM compilation can be cached)

### Risk: Storage conflicts between tests
**Mitigation**:
- Use unique database names per test: `fishy_test_${testId}`
- Clear storage in `beforeEach` hooks
- Use `fake-indexeddb` to isolate from real browser DB

### Risk: Flaky tests due to async timing
**Mitigation**:
- Use `await` for all operations (no setTimeout)
- Assert on final state, not intermediate states
- Use Vitest's `waitFor` helper for async assertions

---

## File Structure

```
packages/
├── core/
│   └── src/
│       └── ribosome/
│           ├── integration.test.ts (re-enabled, 15 suites)
│           ├── automated-tests.test.ts (NEW, 19 zome functions)
│           ├── test-harness.ts (NEW, simulation utilities)
│           └── test-harness.test.ts (NEW, harness self-tests)
└── extension/
    └── test/
        ├── playwright/ (OPTIONAL, Phase 4)
        │   └── extension.spec.ts
        └── wasm-test.html (KEEP for manual edge cases)
```

---

## Documentation Updates

### Update claude.md Step 6.6

```markdown
### Step 6.6: Automated Integration Testing ✅ COMPLETE

**Goal**: Eliminate manual testing loop with automated integration tests

**What was accomplished**:
- ✅ Re-enabled integration.test.ts (15 suites, 30+ tests)
- ✅ Created test harness for simulating extension flow
- ✅ Converted all 19 manual tests to automated tests
- ✅ Added watch mode for continuous testing
- ✅ Integrated with CI pipeline

**Key Benefits**:
- Tests run in <5 seconds
- No manual browser reloading
- Claude sees results directly
- Fix → Test cycle: <10 seconds

**Files Created**:
- `packages/core/src/ribosome/test-harness.ts` (~200 lines)
- `packages/core/src/ribosome/automated-tests.test.ts` (~400 lines)
- `packages/core/src/ribosome/test-harness.test.ts` (~100 lines)

**Canonical Reference**: Always use `../holochain/` for Holochain 0.6 data structures
```

---

## Next Steps After Implementation

Once automated testing is complete:

1. **Step 6.7**: Add Holochain app validation when committing entries
   - Can use automated tests to verify validation rules
   - Test harness makes it easy to test validation failures

2. **Step 7**: Implement network host functions with hc-http-gw
   - Automated tests can mock network layer
   - Test both local and network code paths

3. **Step 8+**: Continue with confidence
   - Every change automatically tested
   - Regressions caught immediately
   - Manual testing only for new UI features
