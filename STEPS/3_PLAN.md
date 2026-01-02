# Step 3: Authorization Mechanism - Implementation Plan

## Overview
Implement user consent flow for page ↔ extension connections (similar to MetaMask), allowing users to approve/deny domains before they can access Holochain APIs through the extension.

## Key Design Decisions

### 1. Permission Granularity: Per-Domain (Simple)
- **Approach**: Single permission level per domain (approved/denied for all operations)
- **Rationale**: "Perfect is the enemy of good" - start simple, iterate later
- **Future expansion**: Can add per-action granularity (READ/WRITE/SIGN) in future steps

### 2. Authorization Flow: Popup Window on First Connection
- **First connection**: Open popup window immediately (like MetaMask) for instant user feedback
- **Popup management**: User can view/manage permissions in main popup settings
- **Rationale**: Best UX - immediate feedback for new connections, centralized management

### 3. Permission Persistence: Permanent (Until Revoked)
- **Default behavior**: Permissions persist across browser restarts
- **User control**: Can revoke anytime from settings
- **Rationale**: Matches MetaMask pattern, reduces user friction

### 4. Blocked Request Behavior: Queue with Timeout
- **Flow**: Request queued → Popup opens → User approves/denies → Response sent
- **Timeout**: 2 minutes - if no response, request fails with timeout error
- **UX**: Clear messaging in popup about which site is requesting access

## Data Structures

```typescript
// packages/extension/src/lib/permissions.ts

interface Permission {
  origin: string;              // Full origin: "https://example.com"
  granted: boolean;            // true = approved, false = denied
  timestamp: number;           // when permission was granted/denied
  userAgent?: string;          // Browser info for auditing
}

interface PendingAuthRequest {
  id: string;                  // Request ID
  origin: string;              // Requesting origin
  tabId: number;               // Tab ID for response
  messageId: string;           // Original message ID to respond to
  timestamp: number;           // When request was made
  timeout: number;             // Timeout handle
}

interface PermissionsState {
  permissions: Record<string, Permission>;  // Keyed by origin
  version: number;             // Schema version for migrations
}
```

## Authorization Flow (User Experience)

### First-Time Connection
```
1. Web page calls: window.holochain.connect()
2. Injected script → Content script → Background
3. Background checks: PermissionManager.checkPermission(origin)
4. NO PERMISSION FOUND
5. Background creates PendingAuthRequest
6. Background opens chrome.windows.create({
     url: "popup/authorize.html?requestId=abc123",
     type: "popup",
     width: 400,
     height: 600
   })
7. User sees authorization popup with:
   - Origin requesting access
   - List of permissions being requested
   - "Approve" / "Deny" buttons
8. User clicks "Approve"
9. authorize.html sends PERMISSION_GRANT message to background
10. Background:
    - Stores permission
    - Resolves pending request
    - Sends SUCCESS response to original CONNECT request
    - Closes popup window
11. Web page receives connect() promise resolution
```

### Subsequent Connections (Already Approved)
```
1. Web page calls: window.holochain.connect()
2. Background checks: PermissionManager.checkPermission(origin)
3. PERMISSION FOUND & GRANTED
4. Background immediately returns SUCCESS response
5. No popup - instant connection
```

### Denied Domain Attempts Connection
```
1. Web page calls: window.holochain.connect()
2. Background checks: PermissionManager.checkPermission(origin)
3. PERMISSION FOUND & DENIED
4. Background immediately returns ERROR response
5. Web page receives rejection
```

## Storage Schema

### chrome.storage.local Structure
```typescript
{
  "fishy_permissions": {
    "version": 1,
    "permissions": {
      "https://example.com": {
        "origin": "https://example.com",
        "granted": true,
        "timestamp": 1735200000000,
        "userAgent": "Mozilla/5.0..."
      },
      "https://untrusted.com": {
        "origin": "https://untrusted.com",
        "granted": false,
        "timestamp": 1735200100000
      }
    }
  }
}
```

## Implementation Order

### Phase 1: Core Infrastructure ✨ START HERE
1. **Create `packages/extension/src/lib/permissions.ts`**
   - PermissionManager class (singleton pattern like LairLock)
   - Methods: checkPermission, grantPermission, denyPermission, revokePermission, listPermissions
   - chrome.storage.local integration
   - STORAGE_KEY = "fishy_permissions"

2. **Create `packages/extension/src/lib/auth-manager.ts`**
   - AuthManager class for pending authorization requests
   - Methods: createAuthRequest, resolveAuthRequest, cleanupExpired
   - Timeout management (2 minute timeout per request)
   - Promise callback storage

3. **Create tests**:
   - `packages/extension/src/lib/permissions.test.ts`
   - `packages/extension/src/lib/auth-manager.test.ts`
   - **Run `npm test`** - all should pass before proceeding

### Phase 2: Message Protocol
4. **Modify `packages/extension/src/lib/messaging.ts`**
   - Add 5 new message types:
     - PERMISSION_GRANT
     - PERMISSION_DENY
     - PERMISSION_LIST
     - PERMISSION_REVOKE
     - AUTH_REQUEST_INFO
   - Update RequestMessage type union
   - Update isRequestMessage type guard

### Phase 3: Background Integration
5. **Modify `packages/extension/src/background/index.ts`**
   - Import PermissionManager and AuthManager
   - Create singleton instances
   - **Modify handleConnect function** (replace TODO comment):
     - Check existing permission
     - If approved: instant success
     - If denied: immediate error
     - If no permission: create auth request and open popup window
   - Add requirePermission() helper function
   - Add permission checks to CALL_ZOME and APP_INFO handlers
   - Add 5 new message handlers:
     - handlePermissionGrant
     - handlePermissionDeny
     - handlePermissionList
     - handlePermissionRevoke
     - handleAuthRequestInfo

### Phase 4: Authorization UI
6. **Create `packages/extension/src/popup/authorize.html`**
   - Popup window layout (400px × 600px)
   - Display requesting origin
   - Show permission list
   - Warning message
   - Approve/Deny buttons
   - Styling similar to lair.html

7. **Create `packages/extension/src/popup/authorize.ts`**
   - Parse URL parameters (requestId)
   - Fetch auth request info from background
   - Display origin
   - Handle approve button → send PERMISSION_GRANT → close window
   - Handle deny button → send PERMISSION_DENY → close window

### Phase 5: Permission Management UI
8. **Create `packages/extension/src/popup/permissions.html`**
   - Follow lair.html styling patterns
   - Table layout for permissions list
   - Back link to index.html
   - Revoke button per permission
   - "Revoke All" button

9. **Create `packages/extension/src/popup/permissions.ts`**
   - Load permissions via PERMISSION_LIST message
   - Render permissions table (origin, status, timestamp)
   - Handle revoke button clicks
   - Handle revoke all button click
   - Refresh list after changes

### Phase 6: Main Popup Integration
10. **Modify `packages/extension/src/popup/index.html`**
    - Add "Manage Permissions" link in nav section
    - Place after "Manage Lair Keystore" link

### Phase 7: Integration Testing
11. **Create `packages/extension/test/authorization-test.html`**
    - Test page with connect button
    - Display connection status
    - Show error messages
    - Test scenarios:
      - First-time connection (should open popup)
      - Approved connection (should succeed instantly)
      - Denied connection (should fail immediately)
      - Revoke and reconnect

12. **Manual Testing Session**
    - Load unpacked extension in Chrome
    - Test all authorization flows
    - Verify popup opens correctly
    - Verify permissions persist across browser restarts
    - Test permission management UI
    - Document any issues

### Phase 8: Documentation & Commit
13. **Update `SESSION.md` and `claude.md`**
    - Mark Step 3 as complete
    - Document implementation notes
    - List files created/modified

14. **Git commit** (only after manual testing passes)
    - Atomic commit with all changes
    - Include test results in commit description

## Critical Files

### Files to Create (9 new files)
1. `packages/extension/src/lib/permissions.ts` - Core permission management
2. `packages/extension/src/lib/auth-manager.ts` - Pending request management
3. `packages/extension/src/lib/permissions.test.ts` - Permission tests
4. `packages/extension/src/lib/auth-manager.test.ts` - Auth manager tests
5. `packages/extension/src/popup/authorize.html` - Authorization popup UI
6. `packages/extension/src/popup/authorize.ts` - Authorization popup logic
7. `packages/extension/src/popup/permissions.html` - Permission management UI
8. `packages/extension/src/popup/permissions.ts` - Permission management logic
9. `packages/extension/test/authorization-test.html` - Manual test page

### Files to Modify (3 files)
1. `packages/extension/src/lib/messaging.ts` - Add 5 new message types
2. `packages/extension/src/background/index.ts` - Add permission checks and handlers
3. `packages/extension/src/popup/index.html` - Add navigation link

## Testing Strategy

### Unit Tests
```typescript
describe("PermissionManager", () => {
  it("should grant permission for origin")
  it("should deny permission for origin")
  it("should revoke permission")
  it("should persist permissions across instances")
  it("should list all permissions")
});

describe("AuthManager", () => {
  it("should create auth request")
  it("should resolve auth request")
  it("should timeout auth request after 2 minutes")
});
```

### Manual Testing Checklist
```
□ First-time connection opens popup
□ Approve grants permission and connects
□ Subsequent connections succeed instantly
□ Deny rejects connection
□ Denied domain shows immediate error on reconnect
□ Permission management UI shows all permissions
□ Revoke removes permission
□ After revoke, connection request opens popup again
□ Permissions persist across browser restart
□ Multiple domains can be managed independently
□ "Revoke All" clears all permissions
```

## Security Considerations

1. **Origin validation**: Always extract and validate sender.tab.url
2. **Storage isolation**: Permissions stored per-browser-profile
3. **Timeout cleanup**: Prevent memory leaks from abandoned requests
4. **Error messages**: Don't leak sensitive information in error responses
5. **User awareness**: Clear messaging about what permissions grant access to

## Future Enhancements (Post-Step 3)

1. **Granular permissions**: Add READ/WRITE/SIGN capability groups
2. **Time-limited permissions**: Add expiration times
3. **Permission scopes**: Limit access to specific DNA hashes or cells
4. **Audit log**: Track all permission grant/deny/revoke events
5. **Import/export**: Allow users to backup/restore permission lists
6. **Notifications**: Browser notifications for permission requests (if popup blocked)

## Dependencies

- chrome.storage API (already available via manifest permissions)
- chrome.windows API (for popup window creation)
- Existing message passing infrastructure
- LairLock pattern as reference implementation
