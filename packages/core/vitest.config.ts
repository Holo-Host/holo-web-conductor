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
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // Exclude tests that use vi.mock which doesn't work with the alias (hoisting issue)
    exclude: [
      "**/node_modules/**",
      "src/network/network.test.ts",
      "src/ribosome/integration.test.ts",
      "test/profiles-integration.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.d.ts"],
    },
  },
});
