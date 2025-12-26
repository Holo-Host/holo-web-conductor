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
        lair: resolve(__dirname, "src/popup/lair.html"),
        authorize: resolve(__dirname, "src/popup/authorize.html"),
        permissions: resolve(__dirname, "src/popup/permissions.html"),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          // Put popup scripts in popup/ directory
          return "popup/[name].js";
        },
        chunkFileNames: "lib/[name]-[hash].js",
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith(".html")) {
            // Keep HTML files in popup directory with original names
            const baseName = assetInfo.name.replace(/^.*[\\/]/, "");
            return `popup/${baseName}`;
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

        // Build inject script as IIFE (runs in page context)
        await viteBuild({
          configFile: false,
          build: {
            outDir: distDir,
            emptyOutDir: false,
            lib: {
              entry: resolve(__dirname, "src/inject/index.ts"),
              formats: ["iife"],
              name: "FishyInject",
              fileName: () => "inject/index.js",
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
        });

        // Copy manifest.json to dist folder
        copyFileSync(
          resolve(__dirname, "manifest.json"),
          resolve(distDir, "manifest.json")
        );

        // Move HTML files from dist/src/popup/*.html to dist/popup/*.html if needed
        const srcPopupDir = resolve(distDir, "src/popup");
        const destPopupDir = resolve(distDir, "popup");

        if (existsSync(srcPopupDir)) {
          // Ensure destination directory exists
          if (!existsSync(destPopupDir)) {
            mkdirSync(destPopupDir, { recursive: true });
          }

          // Copy all HTML files
          const htmlFiles = ["index.html", "lair.html", "authorize.html", "permissions.html"];
          htmlFiles.forEach((file) => {
            const srcPath = resolve(srcPopupDir, file);
            const destPath = resolve(destPopupDir, file);
            if (existsSync(srcPath)) {
              copyFileSync(srcPath, destPath);
            }
          });

          // Remove the dist/src directory
          rmSync(resolve(distDir, "src"), { recursive: true, force: true });
        }
      },
    },
  ],
});
