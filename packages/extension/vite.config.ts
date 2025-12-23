import { defineConfig } from "vite";
import { resolve } from "path";
import { copyFileSync, rmSync, existsSync, mkdirSync } from "fs";
import { build as viteBuild } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    sourcemap: true,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, "src/popup/index.html"),
      },
      output: {
        entryFileNames: "[name]/index.js",
        chunkFileNames: "lib/[name]-[hash].js",
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith(".html")) {
            return "popup/index.html";
          }
          return "assets/[name]-[hash][extname]";
        },
      },
    },
    target: "es2020",
    minify: false,
  },
  resolve: {
    alias: {
      "@fishy/shared": resolve(__dirname, "../shared/src"),
      "@fishy/core": resolve(__dirname, "../core/src"),
      "@fishy/lair": resolve(__dirname, "../lair/src"),
    },
  },
  plugins: [
    {
      name: "build-extension-scripts",
      async closeBundle() {
        const distDir = resolve(__dirname, "dist");

        // Build background script as IIFE
        await viteBuild({
          configFile: false,
          build: {
            outDir: distDir,
            emptyOutDir: false,
            lib: {
              entry: resolve(__dirname, "src/background/index.ts"),
              formats: ["iife"],
              name: "FishyBackground",
              fileName: () => "background/index.js",
            },
            sourcemap: true,
            target: "es2020",
            minify: false,
            rollupOptions: {
              output: {
                extend: true,
              },
            },
          },
          resolve: {
            alias: {
              "@fishy/shared": resolve(__dirname, "../shared/src"),
              "@fishy/core": resolve(__dirname, "../core/src"),
              "@fishy/lair": resolve(__dirname, "../lair/src"),
            },
          },
        });

        // Build content script as IIFE
        await viteBuild({
          configFile: false,
          build: {
            outDir: distDir,
            emptyOutDir: false,
            lib: {
              entry: resolve(__dirname, "src/content/index.ts"),
              formats: ["iife"],
              name: "FishyContent",
              fileName: () => "content/index.js",
            },
            sourcemap: true,
            target: "es2020",
            minify: false,
            rollupOptions: {
              output: {
                extend: true,
              },
            },
          },
          resolve: {
            alias: {
              "@fishy/shared": resolve(__dirname, "../shared/src"),
              "@fishy/core": resolve(__dirname, "../core/src"),
              "@fishy/lair": resolve(__dirname, "../lair/src"),
            },
          },
        });

        // Copy manifest.json to dist folder
        copyFileSync(
          resolve(__dirname, "manifest.json"),
          resolve(distDir, "manifest.json")
        );

        // Move HTML file from dist/src/popup/index.html to dist/popup/index.html if needed
        const srcHtmlPath = resolve(distDir, "src/popup/index.html");
        const destHtmlPath = resolve(distDir, "popup/index.html");

        if (existsSync(srcHtmlPath)) {
          copyFileSync(srcHtmlPath, destHtmlPath);
          // Remove the dist/src directory
          rmSync(resolve(distDir, "src"), { recursive: true, force: true });
        }
      },
    },
  ],
});
