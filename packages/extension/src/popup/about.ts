/**
 * About page - shows version, license, and runtime info
 */

document.addEventListener("DOMContentLoaded", () => {
  // Version from manifest
  const versionEl = document.getElementById("about-version");
  if (versionEl) {
    try {
      const manifest = chrome.runtime.getManifest();
      versionEl.textContent = manifest.version || "0.1.0";
    } catch {
      // keep default
    }
  }

  // Browser detection
  const browserEl = document.getElementById("about-browser");
  if (browserEl) {
    const ua = navigator.userAgent;
    if (ua.includes("Firefox")) {
      browserEl.textContent = "Firefox";
    } else if (ua.includes("Chrome")) {
      browserEl.textContent = "Chrome";
    } else {
      browserEl.textContent = "Browser";
    }
  }
});
