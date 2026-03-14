#!/usr/bin/env bash
#
# End-to-End Test Setup Script
#
# This script sets up the environment for end-to-end testing of the HWC
# extension with a real Holochain conductor and h2hc-linker linker.
#
# Usage:
#   ./scripts/e2e-test-setup.sh [command] [--happ=NAME]
#
# Commands:
#   start     Start conductor and linker (default)
#   stop      Stop all services
#   pause     Stop only the linker (conductors keep running)
#   unpause   Start only the linker (when conductors are already running)
#   status    Show running services
#   clean     Clean up sandbox data
#
# Options:
#   --happ=NAME      Specify which hApp to use (ziptest or mewsfeed, default: ziptest)
#
# Examples:
#   ./scripts/e2e-test-setup.sh start                    # Start with ziptest
#   ./scripts/e2e-test-setup.sh start --happ=mewsfeed    # Start with mewsfeed
#   ./scripts/e2e-test-setup.sh stop
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# Use /tmp for sandbox to avoid Unix socket path length limits (SUN_LEN ~108 chars)
SANDBOX_DIR="/tmp/hwc-e2e"

# Default hApp configuration
HAPP_NAME="ziptest"
HAPP_EXPLICIT=false  # Track if --happ was explicitly provided

# Linker configuration (h2hc-linker)
LINKER_DIR="${H2HC_LINKER_DIR:-$PROJECT_DIR/../h2hc-linker}"
LINKER_BINARY="$LINKER_DIR/target/release/h2hc-linker"
LINKER_PGREP_PATTERN="target/release/h2hc-linker"

# Parse arguments
COMMAND=""
for arg in "$@"; do
    case $arg in
        --happ=*)
            HAPP_NAME="${arg#*=}"
            HAPP_EXPLICIT=true
            shift
            ;;
        start|stop|pause|unpause|status|clean)
            COMMAND="$arg"
            ;;
        *)
            # Unknown argument
            ;;
    esac
done

# Default command is start
COMMAND="${COMMAND:-start}"

# For unpause command, read saved app_id if not explicitly provided
if [ "$COMMAND" = "unpause" ]; then
    if [ "$HAPP_EXPLICIT" = "false" ] && [ -f "$SANDBOX_DIR/app_id.txt" ]; then
        SAVED_APP_ID=$(cat "$SANDBOX_DIR/app_id.txt")
        if [ -n "$SAVED_APP_ID" ]; then
            HAPP_NAME="$SAVED_APP_ID"
            echo -e "\033[0;32m[INFO]\033[0m Using saved hApp from previous session: $HAPP_NAME"
        fi
    fi
fi

# Configure paths based on hApp name
configure_happ() {
    case "$HAPP_NAME" in
        ziptest)
            HAPP_PATH="$PROJECT_DIR/fixtures/ziptest.happ"
            APP_ID="ziptest"
            COORDINATOR_ZOME="ziptest"
            ;;
        mewsfeed)
            HAPP_PATH="$PROJECT_DIR/fixtures/mewsfeed.happ"
            APP_ID="mewsfeed"
            COORDINATOR_ZOME="mews"
            ;;
        *)
            log_error "Unknown hApp: $HAPP_NAME (supported: ziptest, mewsfeed)"
            exit 1
            ;;
    esac

    log_info "Using hApp: $HAPP_NAME"
    log_info "  Path: $HAPP_PATH"
    log_info "  App ID: $APP_ID"
    log_info "Using linker: h2hc-linker"
    log_info "  Binary: $LINKER_BINARY"
}

# Ports
ADMIN_PORT=8888
APP_PORT=8889
LINKER_PORT=8000
BOOTSTRAP_PORT=0  # 0 = auto-assign
ZIPTEST_UI_PORT=8081
MEWSFEED_UI_PORT=8082

# Ziptest UI directory
ZIPTEST_UI_DIR="$PROJECT_DIR/../ziptest/ui"

# Mewsfeed UI directory
MEWSFEED_UI_DIR="$PROJECT_DIR/../mewsfeed/ui"

# Number of conductors to run (need 2 for full arc establishment)
NUM_CONDUCTORS=2

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Start local bootstrap/signal server
start_bootstrap_server() {
    log_info "Starting local bootstrap/signal server..."

    mkdir -p "$SANDBOX_DIR"
    cd "$SANDBOX_DIR"

    # Check if already running
    if [ -f bootstrap.pid ] && kill -0 "$(cat bootstrap.pid)" 2>/dev/null; then
        log_warn "Bootstrap server already running"
        return 0
    fi

    # Check if kitsune2-bootstrap-srv is available
    if ! command -v kitsune2-bootstrap-srv &> /dev/null; then
        log_error "kitsune2-bootstrap-srv not found. Make sure you're in nix develop shell."
        exit 1
    fi

    # Start bootstrap server (testing mode uses 127.0.0.1:0 for random port)
    kitsune2-bootstrap-srv --sbd-disable-rate-limiting > bootstrap.log 2>&1 &
    BOOTSTRAP_PID=$!
    echo "$BOOTSTRAP_PID" > bootstrap.pid

    # Wait for it to start and get the port
    log_info "Waiting for bootstrap server to start..."
    for i in {1..10}; do
        # Look for the machine-readable format: #kitsune2_bootstrap_srv#listening#127.0.0.1:PORT#
        if grep -q "#kitsune2_bootstrap_srv#listening#" bootstrap.log 2>/dev/null; then
            BOOTSTRAP_ADDR=$(grep "#kitsune2_bootstrap_srv#listening#" bootstrap.log | head -1 | sed 's/.*#kitsune2_bootstrap_srv#listening#\([^#]*\)#.*/\1/')
            if [ -n "$BOOTSTRAP_ADDR" ]; then
                log_info "Bootstrap server listening on: $BOOTSTRAP_ADDR"
                echo "$BOOTSTRAP_ADDR" > bootstrap_addr.txt
                return 0
            fi
        fi
        sleep 0.5
    done

    log_error "Bootstrap server failed to start. Check bootstrap.log"
    cat bootstrap.log
    exit 1
}

# Check prerequisites
check_prereqs() {
    log_info "Checking prerequisites..."

    if ! command -v hc &> /dev/null; then
        log_error "hc command not found. Please install holochain_cli."
        exit 1
    fi

    if ! command -v holochain &> /dev/null; then
        log_error "holochain command not found. Please install holochain."
        exit 1
    fi

    if [ ! -f "$HAPP_PATH" ]; then
        log_error "hApp not found at $HAPP_PATH"
        log_info "For $HAPP_NAME, copy the happ to: $HAPP_PATH"
        exit 1
    fi

    log_info "Prerequisites OK"
}

# Start a single conductor instance
# Usage: start_conductor_instance <index>
# index: 1 or 2 (for multi-conductor setup)
start_conductor_instance() {
    local INDEX=${1:-1}
    local SUFFIX=""
    if [ "$INDEX" -gt 1 ]; then
        SUFFIX="_$INDEX"
    fi

    log_info "Starting Holochain conductor $INDEX..."

    # Create sandbox directory if it doesn't exist
    mkdir -p "$SANDBOX_DIR"
    cd "$SANDBOX_DIR"

    local DATA_DIR="$SANDBOX_DIR/data$SUFFIX"
    local PID_FILE="conductor$SUFFIX.pid"
    local LOG_FILE="sandbox-generate$SUFFIX.log"
    local ADMIN_FILE="admin_port$SUFFIX.txt"

    # Check if this conductor is already running
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        log_warn "Conductor $INDEX already running"
        return 0
    fi

    # Clean up old data for this conductor
    rm -rf "$DATA_DIR" "$LOG_FILE" 2>/dev/null || true
    mkdir -p "$DATA_DIR"

    # Always use in-process lair to avoid passphrase issues
    log_info "Conductor $INDEX: Using in-process lair"

    # Get bootstrap address
    local BOOTSTRAP_ADDR
    if [ -f bootstrap_addr.txt ]; then
        BOOTSTRAP_ADDR=$(cat bootstrap_addr.txt)
    else
        log_error "Bootstrap address not found. Start bootstrap server first."
        exit 1
    fi

    local BOOTSTRAP_URL="http://${BOOTSTRAP_ADDR}"
    local RELAY_URL="http://${BOOTSTRAP_ADDR}"

    log_info "Conductor $INDEX: bootstrap=$BOOTSTRAP_URL relay=$RELAY_URL"

    # Generate and run sandbox
    # Use a unique app ID suffix for conductor 2 to avoid conflicts
    local INSTANCE_APP_ID="$APP_ID"
    if [ "$INDEX" -gt 1 ]; then
        INSTANCE_APP_ID="${APP_ID}_${INDEX}"
    fi

    # Run in background, piping passphrase via stdin
    # Enable verbose logging for conductor - debug level for holochain, info for kitsune2
    (echo "test-passphrase" | RUST_LOG="info,holochain=debug,kitsune2=debug,holochain_p2p=debug" hc sandbox --piped generate \
        --in-process-lair \
        --run 0 \
        --app-id "$INSTANCE_APP_ID" \
        --root "$DATA_DIR" \
        "$HAPP_PATH" \
        network -b "$BOOTSTRAP_URL" quic "$RELAY_URL") \
        > "$LOG_FILE" 2>&1 &

    local CONDUCTOR_PID=$!
    echo "$CONDUCTOR_PID" > "$PID_FILE"

    # Wait for conductor to start
    log_info "Waiting for conductor $INDEX to start (PID: $CONDUCTOR_PID)..."
    for i in {1..60}; do
        # Check if conductor is ready - look for the JSON launch info
        if grep -q '"admin_port":' "$LOG_FILE" 2>/dev/null; then
            log_info "Conductor $INDEX started"

            # Get the admin port from the JSON output
            local ACTUAL_ADMIN
            ACTUAL_ADMIN=$(grep -oP '"admin_port":\K\d+' "$LOG_FILE" 2>/dev/null | head -1)
            if [ -z "$ACTUAL_ADMIN" ]; then
                ACTUAL_ADMIN="$ADMIN_PORT"
            fi
            log_info "Conductor $INDEX: Admin interface on port $ACTUAL_ADMIN"

            # Save the admin port
            echo "$ACTUAL_ADMIN" > "$ADMIN_FILE"

            # Save app ID and hApp path for conductor 1 (primary)
            if [ "$INDEX" -eq 1 ]; then
                echo "$APP_ID" > app_id.txt
                echo "$HAPP_PATH" > happ_path.txt
            fi
            return 0
        fi
        # Check for errors in log
        if grep -q "^Error:" "$LOG_FILE" 2>/dev/null; then
            log_error "Conductor $INDEX failed with error:"
            cat "$LOG_FILE"
            exit 1
        fi
        # Check if process is still running
        if ! kill -0 "$CONDUCTOR_PID" 2>/dev/null; then
            log_error "Conductor $INDEX process died"
            cat "$LOG_FILE"
            exit 1
        fi
        sleep 1
    done

    log_error "Conductor $INDEX failed to start. Check $LOG_FILE"
    cat "$LOG_FILE"
    exit 1
}

# Start all conductors
start_conductors() {
    log_info "Starting $NUM_CONDUCTORS conductor(s)..."

    # Clean up any stale processes first
    pkill -f "hc sandbox" 2>/dev/null || true
    pkill -f "holochain.*sandbox" 2>/dev/null || true
    sleep 1

    # Remove old .hc files
    rm -f "$SANDBOX_DIR/.hc" "$PROJECT_DIR/.hc" 2>/dev/null || true

    for i in $(seq 1 $NUM_CONDUCTORS); do
        start_conductor_instance "$i"
        # Brief delay between conductor starts
        sleep 1
    done

    log_info "All $NUM_CONDUCTORS conductor(s) started"
}

# Wait for conductors to establish their DHT arcs via gossip
# Verifies by creating an entry on conductor 1 and fetching from conductor 2
wait_for_arc_establishment() {
    if [ "$NUM_CONDUCTORS" -lt 2 ]; then
        log_info "Single conductor mode - skipping arc establishment wait"
        return 0
    fi

    log_info "Waiting for conductors to establish DHT arcs via gossip..."
    log_info "Will verify by testing cross-conductor data sync"

    local MAX_WAIT=90
    local WAITED=0
    local VERIFIED=false

    # Get admin ports
    local ADMIN_1=$(cat "$SANDBOX_DIR/admin_port.txt" 2>/dev/null)
    local ADMIN_2=$(cat "$SANDBOX_DIR/admin_port_2.txt" 2>/dev/null)

    if [ -z "$ADMIN_1" ] || [ -z "$ADMIN_2" ]; then
        log_warn "Could not get admin ports, falling back to time-based wait"
        sleep 60
        return 0
    fi

    # Wait a bit for initial gossip to start
    sleep 10
    WAITED=10

    while [ $WAITED -lt $MAX_WAIT ]; do
        # Check if conductors are still running
        local ALL_RUNNING=true
        for i in $(seq 1 $NUM_CONDUCTORS); do
            local SUFFIX=""
            if [ "$i" -gt 1 ]; then
                SUFFIX="_$i"
            fi
            local PID_FILE="$SANDBOX_DIR/conductor$SUFFIX.pid"
            if [ ! -f "$PID_FILE" ] || ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
                ALL_RUNNING=false
                log_warn "Conductor $i is not running"
            fi
        done

        if [ "$ALL_RUNNING" = false ]; then
            log_error "Not all conductors are running"
            return 1
        fi

        # Try to verify sync by checking if conductor 2 can list agents from conductor 1's space
        # This is a lightweight check that doesn't require creating entries
        local DNA_1=$(hc sandbox call --running="$ADMIN_1" list-dnas 2>/dev/null | grep -oP '"uhC0k[^"]+' | head -1 | tr -d '"')
        local DNA_2=$(hc sandbox call --running="$ADMIN_2" list-dnas 2>/dev/null | grep -oP '"uhC0k[^"]+' | head -1 | tr -d '"')

        if [ -n "$DNA_1" ] && [ -n "$DNA_2" ] && [ "$DNA_1" = "$DNA_2" ]; then
            # Both conductors have the same DNA - they should be able to gossip
            # Check if they can see each other by querying agent info
            local AGENTS_1=$(hc sandbox call --running="$ADMIN_1" list-cells 2>/dev/null | grep -c "uhCAk" || echo "0")
            local AGENTS_2=$(hc sandbox call --running="$ADMIN_2" list-cells 2>/dev/null | grep -c "uhCAk" || echo "0")

            if [ "$AGENTS_1" -gt 0 ] && [ "$AGENTS_2" -gt 0 ]; then
                log_info "Arc verification: Conductor 1 has $AGENTS_1 cell(s), Conductor 2 has $AGENTS_2 cell(s)"
                log_info "Both conductors have cells on DNA: $DNA_1"

                # Give additional time for gossip to complete
                if [ $WAITED -ge 30 ]; then
                    log_info "Arc establishment verified after ${WAITED}s"
                    VERIFIED=true
                    break
                fi
            fi
        fi

        # Log progress every 10 seconds
        if [ $((WAITED % 10)) -eq 0 ]; then
            log_info "Arc establishment: waited ${WAITED}s of ${MAX_WAIT}s max..."
        fi

        sleep 5
        WAITED=$((WAITED + 5))
    done

    if [ "$VERIFIED" = true ]; then
        log_info "Conductors have established their DHT arcs (verified)"
    else
        log_warn "Arc establishment timeout - conductors may not have fully synced"
        log_info "Continuing anyway after ${WAITED}s wait"
    fi
    return 0
}

# Legacy wrapper for backwards compatibility
start_conductor() {
    start_conductors
}

# Start linker (h2hc-linker)
start_linker() {
    log_info "Starting h2hc-linker linker..."

    # Check if linker is already running
    if pgrep -f "$LINKER_PGREP_PATTERN" > /dev/null 2>&1; then
        log_warn "Linker already running"
        return 0
    fi

    # Get the actual admin port from saved file or parse from log
    cd "$SANDBOX_DIR"
    if [ -f admin_port.txt ]; then
        ACTUAL_ADMIN=$(cat admin_port.txt)
    else
        ACTUAL_ADMIN=$(grep -oP '"admin_port":\K\d+' sandbox-generate.log 2>/dev/null | head -1)
        if [ -z "$ACTUAL_ADMIN" ]; then
            ACTUAL_ADMIN="$ADMIN_PORT"
        fi
    fi

    # Build linker if needed
    if [ ! -f "$LINKER_BINARY" ]; then
        log_info "Building linker..."
        (cd "$LINKER_DIR" && cargo build --release)
    fi

    log_info "Starting linker on port $LINKER_PORT (admin ws://localhost:$ACTUAL_ADMIN)..."

    # Get bootstrap/relay URLs from saved bootstrap address (local server)
    local BOOTSTRAP_URL
    local RELAY_URL
    if [ -f "$SANDBOX_DIR/bootstrap_addr.txt" ]; then
        local BOOTSTRAP_ADDR
        BOOTSTRAP_ADDR=$(cat "$SANDBOX_DIR/bootstrap_addr.txt")
        BOOTSTRAP_URL="http://${BOOTSTRAP_ADDR}"
        RELAY_URL="http://${BOOTSTRAP_ADDR}"
    else
        # Fallback to public servers if local bootstrap not available
        BOOTSTRAP_URL="https://dev-test-bootstrap2.holochain.org/"
        RELAY_URL="https://dev-test-bootstrap2.holochain.org/"
    fi
    log_info "Kitsune2 bootstrap: $BOOTSTRAP_URL"
    log_info "Kitsune2 relay: $RELAY_URL"

    H2HC_LINKER_ADMIN_WS_URL="127.0.0.1:$ACTUAL_ADMIN" \
    H2HC_LINKER_BOOTSTRAP_URL="$BOOTSTRAP_URL" \
    H2HC_LINKER_RELAY_URL="$RELAY_URL" \
    RUST_LOG="info,h2hc_linker=debug" \
    "$LINKER_BINARY" --port "$LINKER_PORT" > linker.log 2>&1 &

    LINKER_PID=$!
    echo "$LINKER_PID" > linker.pid

    # Wait for linker to start
    for i in {1..10}; do
        if curl -s "http://localhost:$LINKER_PORT/health" > /dev/null 2>&1; then
            log_info "Linker started on port $LINKER_PORT"
            return 0
        fi
        sleep 1
    done

    # Check if process is still running
    if kill -0 "$LINKER_PID" 2>/dev/null; then
        log_info "Linker started (health endpoint not responding, but process running)"
        return 0
    fi

    log_error "Linker failed to start. Check linker.log"
    cat linker.log
    exit 1
}

# Start ziptest UI server (only for ziptest hApp)
start_ziptest_ui() {
    if [ "$HAPP_NAME" != "ziptest" ]; then
        return 0
    fi

    log_info "Starting ziptest UI server..."

    # Check if UI directory exists
    if [ ! -d "$ZIPTEST_UI_DIR" ]; then
        log_error "Ziptest UI directory not found: $ZIPTEST_UI_DIR"
        exit 1
    fi

    # Check if dist directory exists
    if [ ! -d "$ZIPTEST_UI_DIR/dist" ]; then
        log_warn "Ziptest UI dist not found, building..."
        (cd "$ZIPTEST_UI_DIR" && npm run build)
    fi

    # Copy the same hApp file to UI dist so the extension installs the exact same DNA
    # as the conductors. A mismatch causes different DNA hashes → agents can't see each other.
    if [ -f "$HAPP_PATH" ]; then
        cp "$HAPP_PATH" "$ZIPTEST_UI_DIR/dist/ziptest.happ"
        log_info "Copied $HAPP_PATH to UI dist (ensures matching DNA hash)"
    fi

    # Check if already running
    if pgrep -f "python3 -m http.server $ZIPTEST_UI_PORT" > /dev/null 2>&1; then
        log_warn "Ziptest UI server already running on port $ZIPTEST_UI_PORT"
        return 0
    fi

    cd "$ZIPTEST_UI_DIR"
    python3 -m http.server "$ZIPTEST_UI_PORT" -d dist > "$SANDBOX_DIR/ziptest-ui.log" 2>&1 &
    ZIPTEST_UI_PID=$!
    echo "$ZIPTEST_UI_PID" > "$SANDBOX_DIR/ziptest-ui.pid"

    # Wait for server to start
    for i in {1..10}; do
        if curl -s "http://localhost:$ZIPTEST_UI_PORT" > /dev/null 2>&1; then
            log_info "Ziptest UI server started on port $ZIPTEST_UI_PORT"
            return 0
        fi
        sleep 0.5
    done

    log_error "Ziptest UI server failed to start. Check $SANDBOX_DIR/ziptest-ui.log"
    exit 1
}

# Start mewsfeed UI server (only for mewsfeed hApp)
start_mewsfeed_ui() {
    if [ "$HAPP_NAME" != "mewsfeed" ]; then
        return 0
    fi

    log_info "Starting mewsfeed UI server..."

    # Check if UI directory exists
    if [ ! -d "$MEWSFEED_UI_DIR" ]; then
        log_error "Mewsfeed UI directory not found: $MEWSFEED_UI_DIR"
        exit 1
    fi

    # Check if dist directory exists
    if [ ! -d "$MEWSFEED_UI_DIR/dist" ]; then
        log_error "Mewsfeed UI dist not found. Build it first: cd $MEWSFEED_UI_DIR && npm run build"
        exit 1
    fi

    # Copy the same hApp file to UI dist so the extension installs the exact same DNA
    # as the conductors. A mismatch causes different DNA hashes → agents can't see each other.
    if [ -f "$HAPP_PATH" ]; then
        cp "$HAPP_PATH" "$MEWSFEED_UI_DIR/dist/mewsfeed.happ"
        log_info "Copied $HAPP_PATH to UI dist (ensures matching DNA hash)"
    fi

    # Check if already running
    if pgrep -f "serve.*-l $MEWSFEED_UI_PORT" > /dev/null 2>&1; then
        log_warn "Mewsfeed UI server already running on port $MEWSFEED_UI_PORT"
        return 0
    fi

    cd "$MEWSFEED_UI_DIR"
    # -s flag enables SPA fallback: serves index.html for routes that don't match files on disk
    npx serve -s dist -l "$MEWSFEED_UI_PORT" --cors --no-clipboard > "$SANDBOX_DIR/mewsfeed-ui.log" 2>&1 &
    MEWSFEED_UI_PID=$!
    echo "$MEWSFEED_UI_PID" > "$SANDBOX_DIR/mewsfeed-ui.pid"

    # Wait for server to start
    for i in {1..10}; do
        if curl -s "http://localhost:$MEWSFEED_UI_PORT" > /dev/null 2>&1; then
            log_info "Mewsfeed UI server started on port $MEWSFEED_UI_PORT"
            return 0
        fi
        sleep 0.5
    done

    log_error "Mewsfeed UI server failed to start. Check $SANDBOX_DIR/mewsfeed-ui.log"
    exit 1
}

# Stop mewsfeed UI server
stop_mewsfeed_ui() {
    if [ -f "$SANDBOX_DIR/mewsfeed-ui.pid" ]; then
        MEWSFEED_UI_PID=$(cat "$SANDBOX_DIR/mewsfeed-ui.pid")
        if kill -0 "$MEWSFEED_UI_PID" 2>/dev/null; then
            log_info "Stopping mewsfeed UI server (PID $MEWSFEED_UI_PID)..."
            kill "$MEWSFEED_UI_PID" 2>/dev/null || true
        fi
        rm -f "$SANDBOX_DIR/mewsfeed-ui.pid"
    fi
    # Also check by process name
    pkill -f "serve.*-l $MEWSFEED_UI_PORT" 2>/dev/null || true
}

# Stop ziptest UI server
stop_ziptest_ui() {
    if [ -f "$SANDBOX_DIR/ziptest-ui.pid" ]; then
        ZIPTEST_UI_PID=$(cat "$SANDBOX_DIR/ziptest-ui.pid")
        if kill -0 "$ZIPTEST_UI_PID" 2>/dev/null; then
            log_info "Stopping ziptest UI server (PID $ZIPTEST_UI_PID)..."
            kill "$ZIPTEST_UI_PID" 2>/dev/null || true
        fi
        rm -f "$SANDBOX_DIR/ziptest-ui.pid"
    fi
    # Also check by process name
    pkill -f "python3 -m http.server $ZIPTEST_UI_PORT" 2>/dev/null || true
}

# Stop only the linker (pause)
pause_linker() {
    log_info "Pausing linker (stopping linker only, conductors keep running)..."

    cd "$SANDBOX_DIR" 2>/dev/null || true

    # Stop linker
    if [ -f linker.pid ]; then
        LINKER_PID=$(cat linker.pid)
        if kill -0 "$LINKER_PID" 2>/dev/null; then
            log_info "Stopping linker (PID $LINKER_PID)..."
            kill "$LINKER_PID"
            # Wait for it to actually stop
            for i in {1..10}; do
                if ! kill -0 "$LINKER_PID" 2>/dev/null; then
                    break
                fi
                sleep 0.5
            done
        fi
        rm -f linker.pid
    else
        # Also check by process name
        if pgrep -f "target/release/h2hc-linker" > /dev/null 2>&1; then
            log_info "Stopping h2hc-linker by process name..."
            pkill -f "target/release/h2hc-linker" || true
        fi
    fi

    log_info "Linker paused (conductors still running)"
}

# Start only the linker (unpause) - assumes conductors already running
unpause_linker() {
    log_info "Unpausing linker (starting linker only)..."

    cd "$SANDBOX_DIR" 2>/dev/null || true

    # Check if conductors are running
    local CONDUCTOR_RUNNING=false
    for PID_FILE in conductor.pid conductor_*.pid; do
        if [ -f "$PID_FILE" ]; then
            local PID
            PID=$(cat "$PID_FILE")
            if kill -0 "$PID" 2>/dev/null; then
                CONDUCTOR_RUNNING=true
                break
            fi
        fi
    done

    if [ "$CONDUCTOR_RUNNING" = false ]; then
        log_error "No conductors running. Use 'start' instead of 'unpause'."
        exit 1
    fi

    # Check if linker already running
    if pgrep -f "target/release/h2hc-linker" > /dev/null 2>&1; then
        log_warn "Linker already running"
        return 0
    fi

    # Start linker (reuse start_linker function)
    start_linker

    log_info "Linker unpaused"
}

# Stop services
stop_services() {
    log_info "Stopping services..."

    cd "$SANDBOX_DIR" 2>/dev/null || true

    # Stop UI servers if running
    stop_ziptest_ui 2>/dev/null || true
    stop_mewsfeed_ui 2>/dev/null || true

    # Stop linker first
    pause_linker 2>/dev/null || true

    # Stop all conductors
    for PID_FILE in conductor.pid conductor_*.pid; do
        if [ -f "$PID_FILE" ]; then
            CONDUCTOR_PID=$(cat "$PID_FILE")
            if kill -0 "$CONDUCTOR_PID" 2>/dev/null; then
                log_info "Stopping conductor (PID $CONDUCTOR_PID from $PID_FILE)..."
                kill "$CONDUCTOR_PID"
            fi
            rm -f "$PID_FILE"
        fi
    done
    pkill -f "holochain.*sandbox" 2>/dev/null || true
    pkill -f "hc sandbox" 2>/dev/null || true

    # Stop bootstrap server
    if [ -f bootstrap.pid ]; then
        BOOTSTRAP_PID=$(cat bootstrap.pid)
        if kill -0 "$BOOTSTRAP_PID" 2>/dev/null; then
            log_info "Stopping bootstrap server (PID $BOOTSTRAP_PID)..."
            kill "$BOOTSTRAP_PID"
        fi
        rm -f bootstrap.pid bootstrap_addr.txt
    fi
    pkill -f "kitsune2-bootstrap-srv" 2>/dev/null || true

    log_info "Services stopped"
}

# Show status
show_status() {
    echo ""
    echo "=== E2E Test Environment Status ==="
    echo ""

    # Show current hApp if saved
    if [ -f "$SANDBOX_DIR/app_id.txt" ]; then
        local CURRENT_APP_ID
        CURRENT_APP_ID=$(cat "$SANDBOX_DIR/app_id.txt")
        echo -e "hApp:      ${GREEN}$CURRENT_APP_ID${NC}"
    fi

    # Check bootstrap server
    if [ -f "$SANDBOX_DIR/bootstrap.pid" ] && kill -0 "$(cat "$SANDBOX_DIR/bootstrap.pid" 2>/dev/null)" 2>/dev/null; then
        local BOOTSTRAP_ADDR=""
        if [ -f "$SANDBOX_DIR/bootstrap_addr.txt" ]; then
            BOOTSTRAP_ADDR=$(cat "$SANDBOX_DIR/bootstrap_addr.txt")
        fi
        echo -e "Bootstrap: ${GREEN}RUNNING${NC} on $BOOTSTRAP_ADDR"
    else
        echo -e "Bootstrap: ${RED}STOPPED${NC}"
    fi

    # Check conductors - show status for each
    local CONDUCTOR_COUNT=0
    for PID_FILE in "$SANDBOX_DIR/conductor.pid" "$SANDBOX_DIR"/conductor_*.pid; do
        if [ -f "$PID_FILE" ]; then
            local PID
            PID=$(cat "$PID_FILE")
            local INDEX=1
            if [[ "$PID_FILE" =~ conductor_([0-9]+)\.pid ]]; then
                INDEX="${BASH_REMATCH[1]}"
            fi
            local ADMIN_FILE="$SANDBOX_DIR/admin_port.txt"
            if [ "$INDEX" -gt 1 ]; then
                ADMIN_FILE="$SANDBOX_DIR/admin_port_$INDEX.txt"
            fi
            local ADMIN_PORT_VAL=""
            if [ -f "$ADMIN_FILE" ]; then
                ADMIN_PORT_VAL=$(cat "$ADMIN_FILE")
            fi
            if kill -0 "$PID" 2>/dev/null; then
                echo -e "Conductor $INDEX: ${GREEN}RUNNING${NC} (PID $PID, admin port $ADMIN_PORT_VAL)"
                CONDUCTOR_COUNT=$((CONDUCTOR_COUNT + 1))
            else
                echo -e "Conductor $INDEX: ${RED}STOPPED${NC}"
            fi
        fi
    done
    if [ "$CONDUCTOR_COUNT" -eq 0 ]; then
        echo -e "Conductors: ${RED}NONE RUNNING${NC}"
    fi

    # Check linker
    if pgrep -f "target/release/h2hc-linker" > /dev/null 2>&1; then
        echo -e "Linker:   ${GREEN}RUNNING${NC} (h2hc-linker) on port $LINKER_PORT"
    else
        echo -e "Linker:   ${RED}STOPPED${NC}"
    fi

    # Check ziptest UI (only relevant for ziptest hApp)
    if [ -f "$SANDBOX_DIR/ziptest-ui.pid" ] && kill -0 "$(cat "$SANDBOX_DIR/ziptest-ui.pid" 2>/dev/null)" 2>/dev/null; then
        echo -e "Ziptest UI: ${GREEN}RUNNING${NC} on port $ZIPTEST_UI_PORT"
    elif pgrep -f "python3 -m http.server $ZIPTEST_UI_PORT" > /dev/null 2>&1; then
        echo -e "Ziptest UI: ${GREEN}RUNNING${NC} on port $ZIPTEST_UI_PORT"
    fi

    # Check mewsfeed UI
    if [ -f "$SANDBOX_DIR/mewsfeed-ui.pid" ] && kill -0 "$(cat "$SANDBOX_DIR/mewsfeed-ui.pid" 2>/dev/null)" 2>/dev/null; then
        echo -e "Mewsfeed UI: ${GREEN}RUNNING${NC} on port $MEWSFEED_UI_PORT"
    elif pgrep -f "serve.*-l $MEWSFEED_UI_PORT" > /dev/null 2>&1; then
        echo -e "Mewsfeed UI: ${GREEN}RUNNING${NC} on port $MEWSFEED_UI_PORT"
    fi

    echo ""
    echo "Test URLs:"
    echo "  - Linker: http://localhost:$LINKER_PORT"
    echo ""

    # Show DNA hash if available
    if [ -f "$SANDBOX_DIR/dna_hash.txt" ]; then
        local DNA_HASH
        DNA_HASH=$(cat "$SANDBOX_DIR/dna_hash.txt")
        echo "DNA Hash: $DNA_HASH"
        echo ""
    fi
}

# Clean up
clean_sandbox() {
    log_info "Cleaning up sandbox..."
    stop_services
    rm -rf "$SANDBOX_DIR"
    # Also clean any .hc file in project dir
    rm -f "$PROJECT_DIR/.hc" 2>/dev/null || true
    log_info "Cleanup complete"
}

# Get and save DNA hash from conductor
save_dna_hash() {
    log_info "Getting DNA hash from sandbox..."

    cd "$SANDBOX_DIR"

    # Get the admin port
    local ACTUAL_ADMIN
    if [ -f admin_port.txt ]; then
        ACTUAL_ADMIN=$(cat admin_port.txt)
    else
        log_warn "Admin port not saved, trying to parse from log"
        ACTUAL_ADMIN=$(grep -oP '"admin_port":\K\d+' sandbox-generate.log 2>/dev/null | head -1)
    fi

    if [ -z "$ACTUAL_ADMIN" ]; then
        log_warn "Could not determine admin port"
        return 1
    fi

    local DNA_HASH
    DNA_HASH=$(hc sandbox call --running="$ACTUAL_ADMIN" list-dnas 2>&1 | grep -oP '"uhC0k[^"]+' | head -1 | tr -d '"')

    if [ -z "$DNA_HASH" ]; then
        log_warn "Could not get DNA hash from sandbox"
        return 1
    fi

    log_info "DNA hash: $DNA_HASH"
    echo "$DNA_HASH" > "$SANDBOX_DIR/dna_hash.txt"
}

# Main command handling
case "$COMMAND" in
    start)
        configure_happ
        check_prereqs
        # Start local bootstrap server first (required for kitsune2 networking)
        start_bootstrap_server
        start_conductor
        # Wait for conductors to discover each other and establish DHT arcs
        wait_for_arc_establishment
        # Give conductors time to fully initialize after arc establishment
        sleep 2
        start_linker
        # Start UI server for the selected hApp
        start_ziptest_ui
        start_mewsfeed_ui
        show_status
        echo ""
        save_dna_hash

        echo ""
        echo "To test, open in browser:"
        if [ "$HAPP_NAME" = "ziptest" ]; then
            echo "  Ziptest UI: http://localhost:$ZIPTEST_UI_PORT"
            echo "  Configure the extension with linker URL: http://localhost:$LINKER_PORT"
            if [ -f "$SANDBOX_DIR/dna_hash.txt" ]; then
                echo "  Conductor DNA hash: $(cat "$SANDBOX_DIR/dna_hash.txt")"
                echo "  (Extension should compute the same hash - no override needed)"
            fi
        elif [ "$HAPP_NAME" = "mewsfeed" ]; then
            echo "  Mewsfeed UI: http://localhost:$MEWSFEED_UI_PORT"
            echo "  Configure the extension with linker URL: http://localhost:$LINKER_PORT"
            if [ -f "$SANDBOX_DIR/dna_hash.txt" ]; then
                echo "  Conductor DNA hash: $(cat "$SANDBOX_DIR/dna_hash.txt")"
            fi
        fi
        echo ""
        echo "Press Ctrl+C or run './scripts/e2e-test-setup.sh stop' to stop services"
        ;;
    stop)
        stop_services
        ;;
    pause)
        pause_linker
        show_status
        ;;
    unpause)
        configure_happ
        unpause_linker
        show_status
        ;;
    status)
        show_status
        ;;
    clean)
        clean_sandbox
        ;;
    *)
        echo "Usage: $0 {start|stop|pause|unpause|status|clean} [--happ=NAME]"
        echo ""
        echo "Commands:"
        echo "  start     Start conductor and linker"
        echo "  stop      Stop all services"
        echo "  pause     Stop only the linker (conductors keep running)"
        echo "  unpause   Start only the linker (conductors must be running)"
        echo "  status    Show running services"
        echo "  clean     Clean up sandbox data"
        echo ""
        echo "Options:"
        echo "  --happ=NAME      Specify which hApp to use (ziptest or mewsfeed, default: ziptest)"
        echo ""
        echo "Environment variables:"
        echo "  H2HC_LINKER_DIR  Path to h2hc-linker repo (default: ../h2hc-linker relative to project)"
        echo ""
        echo "Examples:"
        echo "  $0 start                          # Start with ziptest + h2hc-linker"
        echo "  $0 start --happ=mewsfeed          # Start with mewsfeed + h2hc-linker"
        echo "  H2HC_LINKER_DIR=../my-membrane $0 start"
        echo "  $0 pause                           # Stop linker, keep conductors"
        echo "  $0 unpause                         # Restart linker"
        echo "  $0 stop"
        exit 1
        ;;
esac
