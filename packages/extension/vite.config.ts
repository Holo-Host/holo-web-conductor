import { defineConfig } from "vite";
import { resolve } from "path";
import { copyFileSync, rmSync, existsSync, mkdirSync, readdirSync } from "fs";
import { build as viteBuild } from "vite";

const BROWSER = (process.env.BROWSER || "chrome") as "chrome" | "firefox";
const isFirefox = BROWSER === "firefox";
const distDir = `dist-${BROWSER}`;

const sharedAliases = {
  "@hwc/shared": resolve(__dirname, "../shared/src"),
  "@hwc/core": resolve(__dirname, "../core/src"),
  "@holo-host/lair": resolve(__dirname, "../lair/src"),
  "libsodium-wrappers": resolve(
    __dirname,
    "../../node_modules/libsodium-wrappers/dist/modules/libsodium-wrappers.js"
  ),
};

const sharedDefine = {
  __BROWSER__: JSON.stringify(BROWSER),
};

// HTML inputs: popup pages always included, offscreen only for Chrome
const htmlInputs: Record<string, string> = {
  popup: resolve(__dirname, "src/popup/index.html"),
  lair: resolve(__dirname, "src/popup/lair.html"),
  authorize: resolve(__dirname, "src/popup/authorize.html"),
  permissions: resolve(__dirname, "src/popup/permissions.html"),
  happs: resolve(__dirname, "src/popup/happs.html"),
};
if (!isFirefox) {
  htmlInputs.offscreen = resolve(__dirname, "src/offscreen/offscreen.html");
}

export default defineConfig({
  define: sharedDefine,
  build: {
    outDir: distDir,
    sourcemap: true,
    emptyOutDir: true,
    rollupOptions: {
      input: htmlInputs,
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === "offscreen") {
            return "offscreen/[name].js";
          }
          return "popup/[name].js";
        },
        chunkFileNames: "lib/[name]-[hash].js",
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith(".html")) {
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
    alias: sharedAliases,
  },
  plugins: [
    {
      name: "build-extension-scripts",
      async closeBundle() {
        const outDir = resolve(__dirname, distDir);

        // Build background script as IIFE
        await viteBuild({
          configFile: false,
          define: sharedDefine,
          build: {
            outDir,
            emptyOutDir: false,
            lib: {
              entry: resolve(__dirname, "src/background/index.ts"),
              formats: ["iife"],
              name: "HwcBackground",
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
          resolve: { alias: sharedAliases },
        });

        // Build content script as IIFE
        await viteBuild({
          configFile: false,
          define: sharedDefine,
          build: {
            outDir,
            emptyOutDir: false,
            lib: {
              entry: resolve(__dirname, "src/content/index.ts"),
              formats: ["iife"],
              name: "HwcContent",
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
              "@hwc/shared": resolve(__dirname, "../shared/src"),
              "@hwc/core": resolve(__dirname, "../core/src"),
              "@holo-host/lair": resolve(__dirname, "../lair/src"),
            },
          },
        });

        // Build inject script as IIFE (runs in page context)
        await viteBuild({
          configFile: false,
          define: sharedDefine,
          build: {
            outDir,
            emptyOutDir: false,
            lib: {
              entry: resolve(__dirname, "src/inject/index.ts"),
              formats: ["iife"],
              name: "HwcInject",
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

        // Build offscreen script (Chrome only)
        if (!isFirefox) {
          await viteBuild({
            configFile: false,
            define: sharedDefine,
            build: {
              outDir,
              emptyOutDir: false,
              lib: {
                entry: resolve(__dirname, "src/offscreen/index.ts"),
                formats: ["iife"],
                name: "HwcOffscreen",
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
            resolve: { alias: sharedAliases },
          });
        }

        // Build SQLite worker (Chrome only — Firefox uses it via ribosome worker)
        if (!isFirefox) {
          const sqliteWorkerPath = resolve(__dirname, "src/offscreen/sqlite-worker.ts");
          if (existsSync(sqliteWorkerPath)) {
            await viteBuild({
              configFile: false,
              define: sharedDefine,
              build: {
                outDir,
                emptyOutDir: false,
                lib: {
                  entry: sqliteWorkerPath,
                  formats: ["iife"],
                  name: "HwcSqliteWorker",
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
                  "@hwc/shared": resolve(__dirname, "../shared/src"),
                  "@hwc/core": resolve(__dirname, "../core/src"),
                  "@holo-host/lair": resolve(__dirname, "../lair/src"),
                },
              },
            });
          }
        }

        // Copy SQLite WASM file to offscreen directory (needed by ribosome worker on both browsers)
        const sqliteWasmSrc = resolve(__dirname, "../../node_modules/@sqlite.org/sqlite-wasm/sqlite-wasm/jswasm/sqlite3.wasm");
        const offscreenDir = resolve(outDir, "offscreen");
        if (!existsSync(offscreenDir)) {
          mkdirSync(offscreenDir, { recursive: true });
        }
        const sqliteWasmDest = resolve(offscreenDir, "sqlite3.wasm");
        if (existsSync(sqliteWasmSrc)) {
          copyFileSync(sqliteWasmSrc, sqliteWasmDest);
          console.log("Copied sqlite3.wasm to offscreen/");
        } else {
          console.warn("sqlite3.wasm not found at:", sqliteWasmSrc);
        }

        // Build Ribosome worker as IIFE (needed on both browsers)
        const ribosomeWorkerPath = resolve(__dirname, "src/offscreen/ribosome-worker.ts");
        if (existsSync(ribosomeWorkerPath)) {
          await viteBuild({
            configFile: false,
            define: sharedDefine,
            build: {
              outDir,
              emptyOutDir: false,
              lib: {
                entry: ribosomeWorkerPath,
                formats: ["iife"],
                name: "HwcRibosomeWorker",
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
            resolve: { alias: sharedAliases },
          });
          console.log("Built ribosome-worker.js");
        }

        // Copy manifest to dist folder (browser-specific)
        const manifestSrc = resolve(__dirname, `manifest.${BROWSER}.json`);
        copyFileSync(manifestSrc, resolve(outDir, "manifest.json"));

        // Copy icons to dist folder
        const iconsSrc = resolve(__dirname, "icons");
        const iconsDest = resolve(outDir, "icons");
        if (existsSync(iconsSrc)) {
          if (!existsSync(iconsDest)) {
            mkdirSync(iconsDest, { recursive: true });
          }
          readdirSync(iconsSrc).forEach((file) => {
            copyFileSync(resolve(iconsSrc, file), resolve(iconsDest, file));
          });
        }

        // Move HTML files from dist/src/ to appropriate directories
        const srcDir = resolve(outDir, "src");

        if (existsSync(srcDir)) {
          // Move popup HTML files
          const srcPopupDir = resolve(srcDir, "popup");
          const destPopupDir = resolve(outDir, "popup");

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

          // Move offscreen HTML file (Chrome only)
          if (!isFirefox) {
            const srcOffscreenDir = resolve(srcDir, "offscreen");
            const destOffscreenDir = resolve(outDir, "offscreen");

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
          }

          // Remove the dist/src directory
          rmSync(srcDir, { recursive: true, force: true });
        }

        console.log(`Built ${BROWSER} extension in ${distDir}/`);
      },
    },
  ],
});
