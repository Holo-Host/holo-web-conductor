import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const DIST_DIR = resolve(__dirname, "../dist");

/**
 * Build validation tests
 * These tests verify that the built extension is valid and loadable
 */
describe("build validation", () => {
  beforeAll(() => {
    if (!existsSync(DIST_DIR)) {
      throw new Error(
        `Dist directory not found. Run 'npm run build' first. Looking for: ${DIST_DIR}`
      );
    }
  });

  describe("manifest.json", () => {
    it("should exist in dist directory", () => {
      const manifestPath = resolve(DIST_DIR, "manifest.json");
      expect(existsSync(manifestPath)).toBe(true);
    });

    it("should be valid JSON", () => {
      const manifestPath = resolve(DIST_DIR, "manifest.json");
      const content = readFileSync(manifestPath, "utf-8");
      expect(() => JSON.parse(content)).not.toThrow();
    });

    it("should have manifest_version 3", () => {
      const manifestPath = resolve(DIST_DIR, "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      expect(manifest.manifest_version).toBe(3);
    });

    it("should reference existing files", () => {
      const manifestPath = resolve(DIST_DIR, "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

      // Check background service worker
      expect(manifest.background.service_worker).toBeTruthy();
      const bgPath = resolve(DIST_DIR, manifest.background.service_worker);
      expect(existsSync(bgPath)).toBe(true);

      // Check content scripts
      expect(manifest.content_scripts).toBeTruthy();
      expect(Array.isArray(manifest.content_scripts)).toBe(true);
      manifest.content_scripts.forEach((cs: any) => {
        cs.js.forEach((jsFile: string) => {
          const jsPath = resolve(DIST_DIR, jsFile);
          expect(existsSync(jsPath)).toBe(true);
        });
      });

      // Check popup
      if (manifest.action?.default_popup) {
        const popupPath = resolve(DIST_DIR, manifest.action.default_popup);
        expect(existsSync(popupPath)).toBe(true);
      }
    });
  });

  describe("content script", () => {
    it("should exist at content/index.js", () => {
      const contentPath = resolve(DIST_DIR, "content/index.js");
      expect(existsSync(contentPath)).toBe(true);
    });

    it("should NOT contain ES module import/export statements", () => {
      const contentPath = resolve(DIST_DIR, "content/index.js");
      const content = readFileSync(contentPath, "utf-8");

      // Content scripts cannot use ES module syntax in Chrome extensions
      // They must be bundled as IIFE
      expect(content).not.toMatch(/^import\s+/m);
      expect(content).not.toMatch(/^export\s+/m);
      expect(content).not.toMatch(/^\s*import\s*{/m);
      expect(content).not.toMatch(/^\s*export\s*{/m);
    });

    it("should be wrapped in IIFE or similar non-module pattern", () => {
      const contentPath = resolve(DIST_DIR, "content/index.js");
      const content = readFileSync(contentPath, "utf-8");

      // Should contain IIFE pattern or be a complete non-module script
      // At minimum, should not start with 'import' or 'export'
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
      const bgPath = resolve(DIST_DIR, "background/index.js");
      expect(existsSync(bgPath)).toBe(true);
    });

    // Background scripts CAN use ES modules because manifest specifies type: "module"
    // So we don't restrict their format
  });

  describe("popup", () => {
    it("should have index.html at popup/index.html", () => {
      const popupPath = resolve(DIST_DIR, "popup/index.html");
      expect(existsSync(popupPath)).toBe(true);
    });

    it("should have index.js at popup/index.js", () => {
      const popupJsPath = resolve(DIST_DIR, "popup/index.js");
      expect(existsSync(popupJsPath)).toBe(true);
    });

    it("should NOT have HTML in src directory (should be moved)", () => {
      const wrongPath = resolve(DIST_DIR, "src/popup/index.html");
      expect(existsSync(wrongPath)).toBe(false);
    });
  });

  describe("file structure", () => {
    it("should not have src directory in dist", () => {
      const srcPath = resolve(DIST_DIR, "src");
      expect(existsSync(srcPath)).toBe(false);
    });

    it("should have correct directory structure", () => {
      const requiredDirs = ["background", "content", "popup"];
      requiredDirs.forEach((dir) => {
        const dirPath = resolve(DIST_DIR, dir);
        expect(existsSync(dirPath)).toBe(true);
      });
    });
  });
});
