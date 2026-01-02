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
        happs: resolve(__dirname, "src/popup/happs.html"),
        offscreen: resolve(__dirname, "src/offscreen/offscreen.html"),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          // Put scripts in appropriate directories
          if (chunkInfo.name === "offscreen") {
            return "offscreen/[name].js";
          }
          return "popup/[name].js";
        },
        chunkFileNames: "lib/[name]-[hash].js",
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith(".html")) {
            // Keep HTML files in appropriate directories
            const baseName = assetInfo.name.replace(/^.*[\\/]/, "");
            if (baseName === "offscreen.html") {
              return `offscreen/${baseName}`;
            }
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
      // Force CommonJS version of libsodium-wrappers to avoid ESM module resolution issues
      "libsodium-wrappers": resolve(
        __dirname,
        "../../node_modules/libsodium-wrappers/dist/modules/libsodium-wrappers.js"
      ),
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
              "libsodium-wrappers": resolve(
                __dirname,
                "../../node_modules/libsodium-wrappers/dist/modules/libsodium-wrappers.js"
              ),
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

        // Build offscreen script as IIFE (runs in offscreen document)
        await viteBuild({
          configFile: false,
          build: {
            outDir: distDir,
            emptyOutDir: false,
            lib: {
              entry: resolve(__dirname, "src/offscreen/index.ts"),
              formats: ["iife"],
              name: "FishyOffscreen",
              fileName: () => "offscreen/offscreen.js",
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
              "libsodium-wrappers": resolve(
                __dirname,
                "../../node_modules/libsodium-wrappers/dist/modules/libsodium-wrappers.js"
              ),
            },
          },
        });

        // Build SQLite worker as IIFE (runs in dedicated worker from offscreen document)
        const sqliteWorkerPath = resolve(__dirname, "src/offscreen/sqlite-worker.ts");
        if (existsSync(sqliteWorkerPath)) {
          await viteBuild({
            configFile: false,
            build: {
              outDir: distDir,
              emptyOutDir: false,
              lib: {
                entry: sqliteWorkerPath,
                formats: ["iife"],
                name: "FishySqliteWorker",
                fileName: () => "offscreen/sqlite-worker.js",
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

          // Copy SQLite WASM file to offscreen directory
          // The sqlite-wasm package is in the root node_modules (monorepo hoisting)
          const sqliteWasmSrc = resolve(__dirname, "../../node_modules/@sqlite.org/sqlite-wasm/sqlite-wasm/jswasm/sqlite3.wasm");
          const sqliteWasmDest = resolve(distDir, "offscreen/sqlite3.wasm");
          if (existsSync(sqliteWasmSrc)) {
            copyFileSync(sqliteWasmSrc, sqliteWasmDest);
            console.log("Copied sqlite3.wasm to offscreen/");
          } else {
            console.warn("sqlite3.wasm not found at:", sqliteWasmSrc);
          }
        }

        // Build Ribosome worker as IIFE (runs WASM + SQLite together in dedicated worker)
        const ribosomeWorkerPath = resolve(__dirname, "src/offscreen/ribosome-worker.ts");
        if (existsSync(ribosomeWorkerPath)) {
          await viteBuild({
            configFile: false,
            build: {
              outDir: distDir,
              emptyOutDir: false,
              lib: {
                entry: ribosomeWorkerPath,
                formats: ["iife"],
                name: "FishyRibosomeWorker",
                fileName: () => "offscreen/ribosome-worker.js",
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
                "libsodium-wrappers": resolve(
                  __dirname,
                  "../../node_modules/libsodium-wrappers/dist/modules/libsodium-wrappers.js"
                ),
              },
            },
          });
          console.log("Built ribosome-worker.js");
        }

        // Copy manifest.json to dist folder
        copyFileSync(
          resolve(__dirname, "manifest.json"),
          resolve(distDir, "manifest.json")
        );

        // Move HTML files from dist/src/ to appropriate directories
        const srcDir = resolve(distDir, "src");

        if (existsSync(srcDir)) {
          // Move popup HTML files
          const srcPopupDir = resolve(srcDir, "popup");
          const destPopupDir = resolve(distDir, "popup");

          if (existsSync(srcPopupDir)) {
            if (!existsSync(destPopupDir)) {
              mkdirSync(destPopupDir, { recursive: true });
            }

            const popupHtmlFiles = ["index.html", "lair.html", "authorize.html", "permissions.html", "happs.html"];
            popupHtmlFiles.forEach((file) => {
              const srcPath = resolve(srcPopupDir, file);
              const destPath = resolve(destPopupDir, file);
              if (existsSync(srcPath)) {
                copyFileSync(srcPath, destPath);
              }
            });
          }

          // Move offscreen HTML file
          const srcOffscreenDir = resolve(srcDir, "offscreen");
          const destOffscreenDir = resolve(distDir, "offscreen");

          if (existsSync(srcOffscreenDir)) {
            if (!existsSync(destOffscreenDir)) {
              mkdirSync(destOffscreenDir, { recursive: true });
            }

            const srcPath = resolve(srcOffscreenDir, "offscreen.html");
            const destPath = resolve(destOffscreenDir, "offscreen.html");
            if (existsSync(srcPath)) {
              copyFileSync(srcPath, destPath);
            }
          }

          // Remove the dist/src directory
          rmSync(srcDir, { recursive: true, force: true });
        }
      },
    },
  ],
});
