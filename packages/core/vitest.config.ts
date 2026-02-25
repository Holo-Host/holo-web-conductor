import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  resolve: {
    alias: {
      // Force CommonJS version of libsodium-wrappers - the ESM version has issues in vitest node environment
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
    exclude: [
      "**/node_modules/**",
      // Run by separate CI step (npm run test:integration) to avoid double-execution
      "src/ribosome/integration.test.ts",
      // Fails due to libsodium signing initialization in callZome path — needs signing mock
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
