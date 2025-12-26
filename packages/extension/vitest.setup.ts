/**
 * Vitest setup for extension tests
 *
 * Sets up fake IndexedDB and chrome API mocks for testing in Node environment
 */

import "fake-indexeddb/auto";

// Mock chrome API for tests
const mockStorage: Record<string, any> = {};

global.chrome = {
  storage: {
    local: {
      get: async (keys: string | string[] | null) => {
        if (keys === null || keys === undefined) {
          return mockStorage;
        }
        if (typeof keys === "string") {
          return { [keys]: mockStorage[keys] };
        }
        const result: Record<string, any> = {};
        for (const key of keys) {
          if (key in mockStorage) {
            result[key] = mockStorage[key];
          }
        }
        return result;
      },
      set: async (items: Record<string, any>) => {
        Object.assign(mockStorage, items);
      },
      remove: async (keys: string | string[]) => {
        const keysArray = typeof keys === "string" ? [keys] : keys;
        for (const key of keysArray) {
          delete mockStorage[key];
        }
      },
      clear: async () => {
        for (const key of Object.keys(mockStorage)) {
          delete mockStorage[key];
        }
      },
    },
  },
} as any;
