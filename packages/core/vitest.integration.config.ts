import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Force CommonJS version of libsodium-wrappers
      "libsodium-wrappers":
        "/home/eric/code/metacurrency/holochain/holo-web-conductor/node_modules/libsodium-wrappers/dist/modules/libsodium-wrappers.js",
    },
  },
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    include: [
      "src/ribosome/integration.test.ts",
      "src/ribosome/genesis-self-check.test.ts",
    ],
  },
});
