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
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'WebConductorClient',
      formats: ['es', 'cjs'],
      fileName: (format) => `index.${format === 'es' ? 'js' : 'cjs'}`,
    },
    rollupOptions: {
      // Don't bundle peer dependencies or the joining-service client
      external: ['@holochain/client', '@holo-host/joining-service/client'],
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
      rollupTypes: true,
      insertTypesEntry: true,
    }),
  ],
});
