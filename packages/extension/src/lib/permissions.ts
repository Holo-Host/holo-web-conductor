/**
 * Permission management for Holochain extension
 *
 * Manages domain-based authorization for web pages attempting to
 * connect to the Holochain APIs exposed by the extension.
 */

const STORAGE_KEY = "fishy_permissions";

/**
 * Permission for a web origin
 */
export interface Permission {
  origin: string;           // Full origin: "https://example.com"
  granted: boolean;         // true = approved, false = denied
  timestamp: number;        // when permission was granted/denied
  userAgent?: string;       // Browser info for auditing
}

/**
 * Storage structure for permissions
 */
interface PermissionsState {
  permissions: Record<string, Permission>;  // Keyed by origin
  version: number;          // Schema version for future migrations
}

/**
 * Serializable storage format
 */
interface StoredPermissionsState {
  permissions: Record<string, Permission>;
  version: number;
}

/**
 * Permission manager for domain authorization
 */
export class PermissionManager {
  private currentState: PermissionsState | null = null;
  private ready: Promise<void>;

  constructor() {
    this.ready = this.initialize();
  }

  /**
   * Initialize and load permissions state
   */
  private async initialize(): Promise<void> {
    await this.loadState();
  }

  /**
   * Ensure initialization is complete before operations
   */
  private async ensureReady(): Promise<void> {
    await this.ready;
  }

  /**
   * Load permissions state from chrome.storage.local
   */
  private async loadState(): Promise<void> {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const stored = result[STORAGE_KEY] as StoredPermissionsState | undefined;

    if (stored) {
      this.currentState = {
        permissions: stored.permissions,
        version: stored.version,
      };
    } else {
      // First time - no permissions set yet
      this.currentState = {
        permissions: {},
        version: 1,
      };
    }
  }

  /**
   * Save permissions state to chrome.storage.local
   */
  private async saveState(): Promise<void> {
    if (!this.currentState) {
      throw new Error("Permissions state not initialized");
    }

    const toStore: StoredPermissionsState = {
      permissions: this.currentState.permissions,
      version: this.currentState.version,
    };

    await chrome.storage.local.set({ [STORAGE_KEY]: toStore });
  }

  /**
   * Check permission for an origin
   */
  async checkPermission(origin: string): Promise<Permission | undefined> {
    await this.ensureReady();
    if (!this.currentState) {
      throw new Error("Permissions state not initialized");
    }

    return this.currentState.permissions[origin];
  }

  /**
   * Grant permission for an origin
   */
  async grantPermission(origin: string): Promise<void> {
    await this.ensureReady();
    if (!this.currentState) {
      throw new Error("Permissions state not initialized");
    }

    const permission: Permission = {
      origin,
      granted: true,
      timestamp: Date.now(),
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    };

    this.currentState.permissions[origin] = permission;
    await this.saveState();
  }

  /**
   * Deny permission for an origin
   */
  async denyPermission(origin: string): Promise<void> {
    await this.ensureReady();
    if (!this.currentState) {
      throw new Error("Permissions state not initialized");
    }

    const permission: Permission = {
      origin,
      granted: false,
      timestamp: Date.now(),
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    };

    this.currentState.permissions[origin] = permission;
    await this.saveState();
  }

  /**
   * Revoke permission for an origin (removes it entirely)
   */
  async revokePermission(origin: string): Promise<void> {
    await this.ensureReady();
    if (!this.currentState) {
      throw new Error("Permissions state not initialized");
    }

    delete this.currentState.permissions[origin];
    await this.saveState();
  }

  /**
   * List all permissions
   */
  async listPermissions(): Promise<Permission[]> {
    await this.ensureReady();
    if (!this.currentState) {
      throw new Error("Permissions state not initialized");
    }

    return Object.values(this.currentState.permissions);
  }

  /**
   * Clear all permissions (for testing/reset)
   */
  async clearAllPermissions(): Promise<void> {
    await this.ensureReady();
    if (!this.currentState) {
      throw new Error("Permissions state not initialized");
    }

    this.currentState.permissions = {};
    await this.saveState();
  }

  /**
   * Reset permissions state (for testing or recovery)
   */
  async reset(): Promise<void> {
    await chrome.storage.local.remove(STORAGE_KEY);
    this.currentState = {
      permissions: {},
      version: 1,
    };
  }
}

/**
 * Singleton instance
 */
let permissionManagerInstance: PermissionManager | null = null;

/**
 * Get the singleton PermissionManager instance
 */
export function getPermissionManager(): PermissionManager {
  if (!permissionManagerInstance) {
    permissionManagerInstance = new PermissionManager();
  }
  return permissionManagerInstance;
}
