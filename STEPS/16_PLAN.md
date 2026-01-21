# Step 16: E2E Debugging Automation

## Problem Statement

Currently debugging e2e issues requires manual intervention:
1. Uninstall/reinstall extension after code changes
2. Clear gateway state (hc-http-gw-fork or hc-membrane)
3. Manually copy logs from browser's offscreen document inspector
4. Correlate errors between extension logs and .hc-sandbox/ logs

**Goal**: Enable Claude to run e2e tests and see results programmatically without manual user intervention.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    CLI: npm run e2e                         │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ Env Manager  │  │ Log Collector│  │ Test Runner      │   │
│  │ (wrap script)│  │ (aggregate)  │  │ (Playwright)     │   │
│  └──────────────┘  └──────────────┘  └──────────────────┘   │
└─────────────────────────────────────────────────────────────┘
         │                   │                    │
         ▼                   ▼                    ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────────┐
│ e2e-setup.sh │    │ .hc-sandbox/ │    │ Chrome + Ext     │
│ (conductors, │    │ *.log files  │    │ (browser context)│
│  gateway)    │    │              │    │                  │
└──────────────┘    └──────────────┘    └──────────────────┘
```

---

## Package Structure

```
packages/e2e/
├── package.json
├── tsconfig.json
├── playwright.config.ts
├── src/
│   ├── index.ts              # CLI entry point
│   ├── environment.ts        # e2e-test-setup.sh wrapper
│   ├── browser-context.ts    # Playwright browser setup
│   ├── log-collector.ts      # Multi-source log aggregation
│   ├── test-runner.ts        # Test execution
│   └── types.ts
└── tests/
    ├── dht-ops.test.ts       # DHT operations
    ├── cascade.test.ts       # Network cascade
    └── signals.test.ts       # Remote signals
```

---

## Implementation Sub-tasks

### 16.1: Package Setup
- [ ] Create `packages/e2e/package.json` with dependencies
- [ ] Create `packages/e2e/tsconfig.json`
- [ ] Create `packages/e2e/src/types.ts` with shared types

### 16.2: Environment Manager
- [ ] Create `packages/e2e/src/environment.ts`
- [ ] Wrap `e2e-test-setup.sh` for programmatic control
- [ ] Implement start/stop/clean/status methods
- [ ] Read state from `.hc-sandbox/` files

### 16.3: Log Collector
- [ ] Create `packages/e2e/src/log-collector.ts`
- [ ] Implement file log watching (gateway, conductor, bootstrap)
- [ ] Implement browser console capture integration
- [ ] Implement log correlation by timestamp window

### 16.4: Browser Context
- [ ] Create `packages/e2e/src/browser-context.ts`
- [ ] Set up Playwright persistent context with extension
- [ ] Capture console from all extension contexts
- [ ] Implement extension reload functionality

### 16.5: Test Runner & CLI
- [ ] Create `packages/e2e/src/test-runner.ts`
- [ ] Create `packages/e2e/src/index.ts` CLI entry
- [ ] Create `packages/e2e/playwright.config.ts`
- [ ] Implement JSON and pretty output formats

### 16.6: Test Migration
- [ ] Migrate existing e2e-gateway-test.html tests to Playwright
- [ ] Create `packages/e2e/tests/dht-ops.test.ts`
- [ ] Create `packages/e2e/tests/cascade.test.ts`
- [ ] Create `packages/e2e/tests/signals.test.ts`

### 16.7: Integration
- [ ] Update root `package.json` with e2e scripts
- [ ] Update workspace configuration
- [ ] Verify full e2e workflow works

---

## Key Interfaces

### EnvironmentManager

```typescript
class EnvironmentManager {
  async start(config: { happ: string; gateway: string }): Promise<EnvState>
  async stop(): Promise<void>
  async clean(): Promise<void>
  async pauseGateway(): Promise<void>
  async unpauseGateway(): Promise<void>
  async getStatus(): Promise<EnvState | null>
}
```

### LogCollector

```typescript
class LogCollector {
  attachFileLog(source: string, path: string): void
  attachBrowserContext(context: BrowserContext): void
  getLogs(filter?: { source?: string; level?: string; since?: Date }): LogEntry[]
  correlate(windowMs: number): CorrelatedLogGroup[]
  export(): string  // JSON output
}
```

### Browser Context

```typescript
async function createBrowserContext(extensionPath: string): Promise<{
  context: BrowserContext;
  extensionId: string;
}>
```

---

## Output Formats

### JSON (for Claude parsing)

```json
{
  "timestamp": "2026-01-20T...",
  "environment": { "happ": "fixture1", "gateway": "gw-fork", "dnaHash": "uhC0k..." },
  "results": {
    "total": 5, "passed": 4, "failed": 1,
    "tests": [
      { "name": "create entry", "status": "pass", "duration": 234 },
      { "name": "cascade fetch", "status": "fail", "error": "timeout", "logs": [...] }
    ]
  },
  "logs": {
    "extension": [...],
    "gateway": [...],
    "conductor": [...]
  }
}
```

### Pretty (for terminal)

```
Fishy E2E Test Runner
=====================
Environment: fixture1 + gw-fork | Gateway: http://localhost:8000

  ✓ create entry (234ms)
  ✓ get record (156ms)
  ✗ cascade fetch (timeout)

Results: 4/5 passed

Failed: cascade fetch
  Error: Timeout waiting for network response
  Logs:
    [Gateway] 10:23:45 WARN connection refused
    [Extension] 10:23:45 ERROR fetch failed
```

---

## CLI Commands

```bash
# Run all e2e tests
npm run e2e

# Run with clean state
npm run e2e -- --clean

# Run specific test file
npm run e2e -- --pattern "cascade.test.ts"

# Environment management
npm run e2e:env start
npm run e2e:env stop
npm run e2e:env status

# Stream logs
npm run e2e:logs
```

---

## Dependencies

```json
{
  "devDependencies": {
    "@playwright/test": "^1.40.0",
    "commander": "^11.0.0",
    "tsx": "^4.0.0",
    "tail": "^2.2.6"
  }
}
```

---

## Verification Criteria

After implementation, Claude should be able to:

1. Run `npm run e2e -- --clean` and see structured test results
2. Make a code change, run `npm run e2e` again, see updated results
3. When tests fail, see correlated logs from all sources
4. Use `npm run e2e:env start/stop/status` for environment control
