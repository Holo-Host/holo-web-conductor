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
      // Don't bundle peer dependencies or the joining-service packages
      external: [
        '@holochain/client',
        '@holo-host/joining-service/client',
        '@holo-host/joining-service/ui/shoelace',
      ],
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
