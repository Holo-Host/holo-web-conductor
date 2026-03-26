/// <reference types="vitest" />
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import { resolve } from 'path';

export default defineConfig({
  // Resolve the 'source' condition so file:-linked packages use TS source directly
  resolve: {
    conditions: ['source'],
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        'connect-with-ui': resolve(__dirname, 'src/connect-with-ui.ts'),
        runtime: resolve(__dirname, 'src/runtime.ts'),
      },
      formats: ['es'],
    },
    rollupOptions: {
      // Don't bundle peer dependencies or the joining-service packages.
      // @hwc/shared is intentionally NOT listed — it must be bundled
      // since it's a private workspace package not published to npm.
      external: (id) => {
        // Explicitly bundle @hwc/shared (private, not on npm)
        if (id.startsWith('@hwc/shared')) return false;
        // Externalize peer deps and joining-service
        if (id === '@holochain/client') return true;
        if (id.startsWith('@holo-host/joining-service')) return true;
        return false;
      },
      output: {
        globals: {
          '@holochain/client': 'HolochainClient',
        },
      },
    },
    sourcemap: true,
  },
  plugins: [
    dts({
      insertTypesEntry: true,
    }),
  ],
});
