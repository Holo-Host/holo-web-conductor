import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const EXTENSION_ROOT = resolve(__dirname, "..");
const DIST_CHROME = resolve(EXTENSION_ROOT, "dist-chrome");
const DIST_FIREFOX = resolve(EXTENSION_ROOT, "dist-firefox");

/**
 * Build validation tests
 * These tests verify that the built extension is valid and loadable.
 * Validates both Chrome and Firefox dist directories.
 */

function describeDist(label: string, distDir: string) {
  describe(`${label} build validation`, () => {
    beforeAll(() => {
      if (!existsSync(distDir)) {
        throw new Error(
          `Dist directory not found. Run 'npm run build' first. Looking for: ${distDir}`
        );
      }
    });

    describe("manifest.json", () => {
      it("should exist in dist directory", () => {
        const manifestPath = resolve(distDir, "manifest.json");
        expect(existsSync(manifestPath)).toBe(true);
      });

      it("should be valid JSON", () => {
        const manifestPath = resolve(distDir, "manifest.json");
        const content = readFileSync(manifestPath, "utf-8");
        expect(() => JSON.parse(content)).not.toThrow();
      });

      it("should have manifest_version 3", () => {
        const manifestPath = resolve(distDir, "manifest.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        expect(manifest.manifest_version).toBe(3);
      });

      it("should reference existing files", () => {
        const manifestPath = resolve(distDir, "manifest.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

        // Check background script(s)
        if (manifest.background.service_worker) {
          // Chrome: service_worker
          const bgPath = resolve(distDir, manifest.background.service_worker);
          expect(existsSync(bgPath)).toBe(true);
        } else if (manifest.background.scripts) {
          // Firefox: scripts array
          for (const script of manifest.background.scripts) {
            const bgPath = resolve(distDir, script);
            expect(existsSync(bgPath)).toBe(true);
          }
        } else {
          expect.fail("manifest.background must have service_worker or scripts");
        }

        // Check content scripts
        expect(manifest.content_scripts).toBeTruthy();
        expect(Array.isArray(manifest.content_scripts)).toBe(true);
        manifest.content_scripts.forEach((cs: any) => {
          cs.js.forEach((jsFile: string) => {
            const jsPath = resolve(distDir, jsFile);
            expect(existsSync(jsPath)).toBe(true);
          });
        });

        // Check popup
        if (manifest.action?.default_popup) {
          const popupPath = resolve(distDir, manifest.action.default_popup);
          expect(existsSync(popupPath)).toBe(true);
        }
      });
    });

    describe("content script", () => {
      it("should exist at content/index.js", () => {
        const contentPath = resolve(distDir, "content/index.js");
        expect(existsSync(contentPath)).toBe(true);
      });

      it("should NOT contain ES module import/export statements", () => {
        const contentPath = resolve(distDir, "content/index.js");
        const content = readFileSync(contentPath, "utf-8");

        // Content scripts cannot use ES module syntax in Chrome extensions
        // They must be bundled as IIFE
        expect(content).not.toMatch(/^import\s+/m);
        expect(content).not.toMatch(/^export\s+/m);
        expect(content).not.toMatch(/^\s*import\s*{/m);
        expect(content).not.toMatch(/^\s*export\s*{/m);
      });

      it("should be wrapped in IIFE or similar non-module pattern", () => {
        const contentPath = resolve(distDir, "content/index.js");
        const content = readFileSync(contentPath, "utf-8");

        const firstNonCommentLine = content
          .split("\n")
          .find((line) => line.trim() && !line.trim().startsWith("//"));

        expect(firstNonCommentLine).toBeTruthy();
        expect(firstNonCommentLine).not.toMatch(/^import\s/);
        expect(firstNonCommentLine).not.toMatch(/^export\s/);
      });
    });

    describe("background script", () => {
      it("should exist at background/index.js", () => {
        const bgPath = resolve(distDir, "background/index.js");
        expect(existsSync(bgPath)).toBe(true);
      });
    });

    describe("popup", () => {
      it("should have index.html at popup/index.html", () => {
        const popupPath = resolve(distDir, "popup/index.html");
        expect(existsSync(popupPath)).toBe(true);
      });

      it("should have popup.js at popup/popup.js", () => {
        const popupJsPath = resolve(distDir, "popup/popup.js");
        expect(existsSync(popupJsPath)).toBe(true);
      });

      it("should have lair.html at popup/lair.html", () => {
        const lairPath = resolve(distDir, "popup/lair.html");
        expect(existsSync(lairPath)).toBe(true);
      });

      it("should have lair.js at popup/lair.js", () => {
        const lairJsPath = resolve(distDir, "popup/lair.js");
        expect(existsSync(lairJsPath)).toBe(true);
      });

      it("should NOT have HTML in src directory (should be moved)", () => {
        const wrongPath = resolve(distDir, "src/popup/index.html");
        expect(existsSync(wrongPath)).toBe(false);
      });
    });

    describe("inject script", () => {
      it("should exist at inject/index.js", () => {
        const injectPath = resolve(distDir, "inject/index.js");
        expect(existsSync(injectPath)).toBe(true);
      });

      it("should NOT contain ES module import/export statements", () => {
        const injectPath = resolve(distDir, "inject/index.js");
        const content = readFileSync(injectPath, "utf-8");

        expect(content).not.toMatch(/^import\s+/m);
        expect(content).not.toMatch(/^export\s+/m);
        expect(content).not.toMatch(/^\s*import\s*{/m);
        expect(content).not.toMatch(/^\s*export\s*{/m);
      });

      it("should be listed in web_accessible_resources", () => {
        const manifestPath = resolve(distDir, "manifest.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

        expect(manifest.web_accessible_resources).toBeTruthy();
        const hasInjectResource = manifest.web_accessible_resources.some(
          (resource: any) =>
            resource.resources &&
            resource.resources.includes("inject/index.js")
        );
        expect(hasInjectResource).toBe(true);
      });
    });

    describe("file structure", () => {
      it("should not have src directory in dist", () => {
        const srcPath = resolve(distDir, "src");
        expect(existsSync(srcPath)).toBe(false);
      });

      it("should have correct directory structure", () => {
        const requiredDirs = ["background", "content", "popup", "inject"];
        requiredDirs.forEach((dir) => {
          const dirPath = resolve(distDir, dir);
          expect(existsSync(dirPath)).toBe(true);
        });
      });
    });
  });
}

describeDist("Chrome (dist-chrome)", DIST_CHROME);
describeDist("Firefox (dist-firefox)", DIST_FIREFOX);
