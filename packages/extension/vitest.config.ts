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
      // Mirror tsconfig paths so vitest can resolve workspace packages
      "@hwc/core": resolve(__dirname, "../core/src"),
      "@holo-host/lair": resolve(__dirname, "../lair/src"),
      "@hwc/shared": resolve(__dirname, "../shared/src"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    exclude: [
      "**/node_modules/**",
    ],
  },
});
