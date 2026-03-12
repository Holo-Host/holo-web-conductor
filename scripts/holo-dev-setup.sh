#!/usr/bin/env bash
# holo-dev-setup.sh — Verify and prepare the local development environment
# for projects that depend on @holo-host packages (lair, joining-service, web-conductor-client).
#
# Usage:
#   ./scripts/holo-dev-setup.sh              Verify layout and build packages
#   ./scripts/holo-dev-setup.sh --check      Verify only, don't build
#   ./scripts/holo-dev-setup.sh --clone      Clone missing repos, then verify and build
#   ./scripts/holo-dev-setup.sh --help       Show usage
#
# Expected directory layout (all repos as siblings):
#   parent/
#   ├── holo-web-conductor/     (this repo)
#   ├── joining-service/        (optional — needed if your app uses joining flows)
#   └── h2hc-linker/            (optional — needed to run a local linker)
#
# For hApp developers who also need the linker binary but don't want to build
# from source, use --download-linker to fetch a prebuilt binary from GitHub.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HWC_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PARENT_DIR="$(cd "$HWC_DIR/.." && pwd)"

# --- Defaults ---
MODE="build"       # build | check | clone
DOWNLOAD_LINKER=false

# --- Parse args ---
for arg in "$@"; do
    case "$arg" in
        --check)           MODE="check" ;;
        --clone)           MODE="clone" ;;
        --download-linker) DOWNLOAD_LINKER=true ;;
        --help|-h)
            sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
            exit 0
            ;;
        *) echo "Unknown option: $arg"; exit 1 ;;
    esac
done

# --- Logging ---
log_info()  { echo -e "\033[0;36m[holo-dev]\033[0m $*"; }
log_ok()    { echo -e "\033[0;32m[holo-dev]\033[0m $*"; }
log_warn()  { echo -e "\033[0;33m[holo-dev]\033[0m $*"; }
log_error() { echo -e "\033[0;31m[holo-dev]\033[0m $*"; }

# --- Repo checks ---
REPOS_FOUND=()
REPOS_MISSING=()

check_repo() {
    local name="$1"
    local path="$PARENT_DIR/$name"
    local required="${2:-optional}"

    if [ -d "$path" ] && [ -f "$path/package.json" -o -f "$path/Cargo.toml" ]; then
        REPOS_FOUND+=("$name")
        log_ok "$name found at $path"
        return 0
    else
        REPOS_MISSING+=("$name")
        if [ "$required" = "required" ]; then
            log_error "$name NOT FOUND at $path (required)"
        else
            log_warn "$name not found at $path (optional)"
        fi
        return 1
    fi
}

clone_repo() {
    local name="$1"
    local gh_path="$2"
    local path="$PARENT_DIR/$name"

    if [ -d "$path" ]; then
        return 0
    fi

    log_info "Cloning $name..."
    git clone "https://github.com/$gh_path.git" "$path"
    log_ok "Cloned $name to $path"
}

# --- Verify file: deps resolve ---
check_file_dep() {
    local pkg_json="$1"
    local dep_name="$2"
    local description="$3"

    if [ ! -f "$pkg_json" ]; then
        return 0
    fi

    local file_ref
    file_ref=$(grep -o "\"$dep_name\": \"file:[^\"]*\"" "$pkg_json" 2>/dev/null || true)
    if [ -z "$file_ref" ]; then
        return 0
    fi

    # Extract the relative path
    local rel_path
    rel_path=$(echo "$file_ref" | sed "s/.*file:\([^\"]*\)\"/\1/")
    local pkg_dir
    pkg_dir=$(dirname "$pkg_json")
    local abs_path="$pkg_dir/$rel_path"

    if [ -d "$abs_path" ]; then
        log_ok "$description: $dep_name -> $(cd "$abs_path" && pwd)"
    else
        log_error "$description: $dep_name points to $abs_path which does not exist"
        log_error "  (from $pkg_json)"
        return 1
    fi
}

# --- Detect linker binary ---
check_linker_binary() {
    local linker_dir="$PARENT_DIR/h2hc-linker"

    # Check for built binary
    if [ -f "$linker_dir/target/release/h2hc-linker" ]; then
        log_ok "h2hc-linker binary found (built from source)"
        return 0
    fi

    # Check for downloaded binary
    if [ -f "$linker_dir/h2hc-linker" ] && [ -x "$linker_dir/h2hc-linker" ]; then
        log_ok "h2hc-linker binary found (prebuilt)"
        return 0
    fi

    # Check PATH
    if command -v h2hc-linker &>/dev/null; then
        log_ok "h2hc-linker found in PATH: $(command -v h2hc-linker)"
        return 0
    fi

    log_warn "h2hc-linker binary not found. Options:"
    log_warn "  1. Build from source: cd $linker_dir && nix develop -c cargo build --release"
    log_warn "  2. Download prebuilt: re-run with --download-linker"
    return 1
}

download_linker_binary() {
    local linker_dir="$PARENT_DIR/h2hc-linker"
    local tag="v0.1.0"
    local base_url="https://github.com/holo-host/h2hc-linker/releases/download/$tag"

    # Detect platform
    local asset=""
    case "$(uname -s)-$(uname -m)" in
        Linux-x86_64)  asset="h2hc-linker-linux-x86_64" ;;
        Linux-aarch64) asset="h2hc-linker-linux-aarch64" ;;
        Darwin-arm64)  asset="h2hc-linker-macos-aarch64" ;;
        *)
            log_error "No prebuilt linker binary for $(uname -s)-$(uname -m)"
            log_error "Build from source: cd $linker_dir && nix develop -c cargo build --release"
            return 1
            ;;
    esac

    mkdir -p "$linker_dir"
    local url="$base_url/$asset"
    local dest="$linker_dir/h2hc-linker"

    log_info "Downloading $asset from $url..."
    if curl -fSL -o "$dest" "$url"; then
        chmod +x "$dest"
        log_ok "Downloaded linker binary to $dest"
    else
        log_error "Download failed. The release may not exist yet at $url"
        log_error "Build from source instead: cd $linker_dir && nix develop -c cargo build --release"
        return 1
    fi
}

# --- Build packages ---
build_packages() {
    log_info "Building @holo-host/lair..."
    (cd "$HWC_DIR" && npm run build --workspace=packages/lair)
    log_ok "@holo-host/lair built"

    log_info "Building @holo-host/web-conductor-client..."
    (cd "$HWC_DIR" && npm run build --workspace=packages/client)
    log_ok "@holo-host/web-conductor-client built"

    if [ -d "$PARENT_DIR/joining-service" ]; then
        log_info "Building @holo-host/joining-service..."
        (cd "$PARENT_DIR/joining-service" && npm run build)
        log_ok "@holo-host/joining-service built"
    fi
}

# ============================================================
# Main
# ============================================================

echo ""
log_info "=== Holo Development Environment Setup ==="
log_info "HWC repo:   $HWC_DIR"
log_info "Parent dir: $PARENT_DIR"
log_info "Mode:       $MODE"
echo ""

# --- Clone if requested ---
if [ "$MODE" = "clone" ]; then
    clone_repo "holo-web-conductor" "holo-host/holo-web-conductor"
    clone_repo "joining-service"    "holo-host/joining-service"
    clone_repo "h2hc-linker"       "holo-host/h2hc-linker"
    echo ""
fi

# --- Check repo layout ---
log_info "--- Checking repository layout ---"
errors=0

check_repo "holo-web-conductor" "required" || ((errors++))
check_repo "joining-service" "optional" || true
check_repo "h2hc-linker" "optional" || true
echo ""

# --- Check file: dependency resolution ---
log_info "--- Checking file: dependency links ---"

# joining-service -> @holo-host/lair
check_file_dep \
    "$PARENT_DIR/joining-service/package.json" \
    "@holo-host/lair" \
    "joining-service" || ((errors++))

# web-conductor-client -> @holo-host/joining-service
check_file_dep \
    "$HWC_DIR/packages/client/package.json" \
    "@holo-host/joining-service" \
    "web-conductor-client" || ((errors++))

echo ""

# --- Check for consuming hApps ---
log_info "--- Checking hApp consumers (if present) ---"
for candidate in "$PARENT_DIR"/*/ui/package.json; do
    [ -f "$candidate" ] || continue
    local_repo=$(basename "$(dirname "$(dirname "$candidate")")")
    [ "$local_repo" = "holo-web-conductor" ] && continue

    check_file_dep "$candidate" "@holo-host/web-conductor-client" "$local_repo/ui" || ((errors++))
    check_file_dep "$candidate" "@holo-host/joining-service" "$local_repo/ui" || true
done
echo ""

# --- Check linker binary ---
log_info "--- Checking linker binary ---"
if [ "$DOWNLOAD_LINKER" = true ]; then
    download_linker_binary || ((errors++))
else
    check_linker_binary || true  # not an error, just a warning
fi
echo ""

# --- npm install ---
if [ "$MODE" != "check" ]; then
    log_info "--- Running npm install ---"

    log_info "npm install in holo-web-conductor..."
    (cd "$HWC_DIR" && npm install)

    if [ -d "$PARENT_DIR/joining-service" ]; then
        log_info "npm install in joining-service..."
        (cd "$PARENT_DIR/joining-service" && npm install)
    fi
    echo ""
fi

# --- Build ---
if [ "$MODE" != "check" ]; then
    log_info "--- Building packages ---"
    build_packages
    echo ""
fi

# --- Summary ---
if [ "$errors" -gt 0 ]; then
    log_error "Setup completed with $errors error(s). See above."
    exit 1
fi

log_ok "=== Setup complete ==="
echo ""
log_info "Repos found: ${REPOS_FOUND[*]:-none}"
if [ ${#REPOS_MISSING[@]} -gt 0 ]; then
    log_info "Repos not found (optional): ${REPOS_MISSING[*]}"
fi
echo ""
log_info "Next steps:"
if [ "$MODE" = "check" ]; then
    log_info "  Run without --check to build packages"
fi
log_info "  Load the extension: npm run build:extension (then load dist-chrome/ in chrome://extensions)"
log_info "  Run e2e tests:      npm test"
echo ""
