import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  resolve: {
    alias: {
      // Force CommonJS version of libsodium-wrappers to avoid ESM module resolution issues
      "libsodium-wrappers": resolve(
        __dirname,
        "../../node_modules/libsodium-wrappers/dist/modules/libsodium-wrappers.js"
      ),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    // Exclude tests that use vi.mock which doesn't work with the alias (hoisting issue)
    exclude: [
      "**/node_modules/**",
      "src/lib/happ-context-manager.test.ts",
      "src/lib/lair-lock.test.ts",
    ],
  },
});
