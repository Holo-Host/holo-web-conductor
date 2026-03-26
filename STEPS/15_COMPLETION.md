# Step 15: Robust Publish Verification - Completion Notes

**Status**: Complete

## Problem

On WebSocket reconnect, the extension used a blind 2-second `setTimeout` before retrying failed publishes. No verification that peers were available. Ops that exhausted 5 retries were permanently stuck in Failed status with no automatic recovery.

## What Was Implemented

### Linker: peer_count in pong
- `ServerMessage::Pong` now includes `peer_count: usize`
- `GatewayKitsune::peer_count()` sums peers across all kitsune2 spaces
- Linker responds to every ping with current network peer count

### Extension: peer-gated publish retry
- `WebSocketNetworkService.pingForPeerCount(timeoutMs)` sends a ping and resolves with the pong's peer_count (falls back to cached value after timeout)
- On reconnect, `retryPublishesAfterReconnect()` pings for peer count, resets all failed ops (including retry-exhausted) back to Pending, then processes the queue
- Shared function in `packages/core/src/dht/publish-retry.ts` used by both Chrome offscreen and Firefox base-executor

### Client: peerCount in ConnectionStatus
- `ConnectionStatus.peerCount` exposed to hApps via `getConnectionStatus()` and `onConnectionChange()`
- `ConnectionStatus` type consolidated into `@hwc/shared` (was duplicated in 3 places)
- `setLinkerHealth` refactored from 6 positional params to `Partial<ConnectionState>` so new fields flow through automatically
- Inject script mirror has comment marker for manual sync

### Failed op recovery on reconnect
- `PublishTracker.resetFailedForDnas()` called on every reconnect before queue processing
- Ops that hit the 5-retry limit are no longer permanently stuck
- Reconnection is treated as a fresh start since previous failure reasons (e.g. "no peers") are stale

## Files Created

| File | Description |
|------|-------------|
| `packages/core/src/dht/publish-retry.ts` | Shared reconnect retry logic |
| `packages/core/src/dht/publish-retry.test.ts` | 7 tests for retry logic |

## Files Modified

| Package | File | Change |
|---------|------|--------|
| h2hc-linker | `src/routes/websocket.rs` | peer_count in Pong, updated ping handler |
| h2hc-linker | `src/gateway_kitsune.rs` | `peer_count()` method |
| core | `src/network/websocket-service.ts` | pong tracking, `getPeerCount()`, `pingForPeerCount()` |
| core | `src/dht/index.ts` | Export `retryPublishesAfterReconnect` |
| shared | `src/index.ts` | Canonical `ConnectionStatus` type |
| extension | `src/offscreen/index.ts` | Use shared retry function |
| extension | `src/background/base-executor.ts` | Use shared retry function |
| extension | `src/background/index.ts` | Import `ConnectionStatus` from shared, sync peerCount in health check |
| extension | `src/background/chrome-offscreen-executor.ts` | Pass peerCount through |
| extension | `src/inject/index.ts` | Add peerCount to mirrored type |
| extension | `src/lib/zome-executor.ts` | peerCount in WsStateInfo |
| client | `src/connection/monitor.ts` | `setLinkerHealth(Partial<ConnectionState>)` |
| client | `src/connection/types.ts` | peerCount field |
| client | `src/types.ts` | Use shared ConnectionStatus |
| client | `src/WebConductorAppClient.ts` | Pass full status object to setLinkerHealth |

## Test Coverage

- `websocket-service.test.ts`: peer count tracking, `pingForPeerCount` (resolve, timeout, not-connected)
- `publish-retry.test.ts`: peer ping, failed op reset, unique DNA dedup, no-registration no-op, custom timeout, unknown peer count, skip reset log
- `chrome-offscreen-executor.test.ts`: peerCount in getWebSocketState
- `WebConductorAppClient.test.ts`: peerCount flows through to getConnectionState
- `monitor.test.ts`: peerCount in setLinkerHealth, health check propagation, change detection
- `shared/index.test.ts`: ConnectionStatus shape parity check
