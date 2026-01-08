#!/usr/bin/env bash
#
# End-to-End Test Setup Script
#
# This script sets up the environment for end-to-end testing of the fishy
# extension with a real Holochain conductor and gateway.
#
# Usage:
#   ./scripts/e2e-test-setup.sh [command] [--happ=NAME]
#
# Commands:
#   start     Start conductor and gateway (default)
#   stop      Stop all services
#   status    Show running services
#   clean     Clean up sandbox data
#
# Options:
#   --happ=NAME   Specify which hApp to use (fixture1 or ziptest, default: fixture1)
#
# Examples:
#   ./scripts/e2e-test-setup.sh start                    # Start with fixture1
#   ./scripts/e2e-test-setup.sh start --happ=ziptest     # Start with ziptest
#   ./scripts/e2e-test-setup.sh stop
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
GATEWAY_DIR="$(cd "$PROJECT_DIR/../hc-http-gw-fork" && pwd)"
SANDBOX_DIR="$PROJECT_DIR/.hc-sandbox"

# Default hApp configuration
HAPP_NAME="fixture1"

# Parse arguments
COMMAND=""
for arg in "$@"; do
    case $arg in
        --happ=*)
            HAPP_NAME="${arg#*=}"
            shift
            ;;
        start|stop|status|clean)
            COMMAND="$arg"
            ;;
        *)
            # Unknown argument
            ;;
    esac
done

# Default command is start
COMMAND="${COMMAND:-start}"

# Configure paths based on hApp name
configure_happ() {
    case "$HAPP_NAME" in
        fixture1)
            HAPP_PATH="$GATEWAY_DIR/fixture/package/happ1/fixture1.happ"
            APP_ID="fixture1"
            # Zome names for fixture1
            COORDINATOR_ZOME="coordinator1"
            TEST_FN="create_known_entry"
            ;;
        ziptest)
            HAPP_PATH="$PROJECT_DIR/fixtures/ziptest.happ"
            APP_ID="ziptest"
            # Zome names for ziptest
            COORDINATOR_ZOME="ziptest"
            TEST_FN=""  # No test entry function for ziptest
            ;;
        *)
            log_error "Unknown hApp: $HAPP_NAME (supported: fixture1, ziptest)"
            exit 1
            ;;
    esac

    log_info "Using hApp: $HAPP_NAME"
    log_info "  Path: $HAPP_PATH"
    log_info "  App ID: $APP_ID"
}

# Ports
ADMIN_PORT=8888
APP_PORT=8889
GATEWAY_PORT=8000
BOOTSTRAP_PORT=0  # 0 = auto-assign

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
        if [ "$HAPP_NAME" = "fixture1" ]; then
            log_warn "hApp not found at $HAPP_PATH"
            log_info "Building fixture hApp..."
            (cd "$GATEWAY_DIR/fixture" && RUSTFLAGS='--cfg getrandom_backend="custom"' cargo build --release --target wasm32-unknown-unknown && ./package.sh)
        else
            log_error "hApp not found at $HAPP_PATH"
            log_info "For ziptest, copy the happ to: $PROJECT_DIR/fixtures/ziptest.happ"
            exit 1
        fi
    fi

    log_info "Prerequisites OK"
}

# Start conductor
start_conductor() {
    log_info "Starting Holochain conductor..."

    # Create sandbox directory if it doesn't exist
    mkdir -p "$SANDBOX_DIR"
    cd "$SANDBOX_DIR"

    # Check if conductor is already running by looking for hc sandbox process
    if pgrep -f "hc sandbox" > /dev/null 2>&1; then
        # Verify it's actually responding
        if [ -f sandbox-generate.log ] && grep -q "running conductor" sandbox-generate.log 2>/dev/null; then
            log_warn "Conductor already running"
            return 0
        fi
    fi

    # Clean up old sandbox and any stale processes
    pkill -f "hc sandbox" 2>/dev/null || true
    sleep 1
    rm -rf .hc conductor-* *.yaml sandbox-generate.log 2>/dev/null || true

    # Generate a new sandbox with the hApp
    log_info "Generating sandbox with $HAPP_NAME hApp..."

    # Use a directory in the sandbox dir to avoid /tmp issues
    export HC_SANDBOX_DATADIR="$SANDBOX_DIR/data"
    mkdir -p "$HC_SANDBOX_DATADIR"

    # Always use in-process lair to avoid passphrase issues
    log_info "Using in-process lair (no external lair-keystore needed)"

    # Get bootstrap address
    local BOOTSTRAP_ADDR
    if [ -f bootstrap_addr.txt ]; then
        BOOTSTRAP_ADDR=$(cat bootstrap_addr.txt)
    else
        log_error "Bootstrap address not found. Start bootstrap server first."
        exit 1
    fi

    local BOOTSTRAP_URL="http://${BOOTSTRAP_ADDR}"
    local SIGNAL_URL="ws://${BOOTSTRAP_ADDR}"
    local WEBRTC_CONFIG="$SCRIPT_DIR/webrtc-config.json"

    log_info "Using local bootstrap: $BOOTSTRAP_URL"
    log_info "Using local signal: $SIGNAL_URL"
    log_info "Using WebRTC config: $WEBRTC_CONFIG"

    # Generate and run sandbox in one step using --run
    # --piped is a GLOBAL option that must come BEFORE the subcommand
    # Use network subcommand to set bootstrap and signal URLs
    # IMPORTANT: hApp path must come BEFORE network subcommand
    log_info "Running: hc sandbox --piped generate --in-process-lair --run 0 --app-id $APP_ID $HAPP_PATH network -b $BOOTSTRAP_URL webrtc $SIGNAL_URL $WEBRTC_CONFIG ..."

    # Run in background, piping passphrase via stdin
    # The passphrase "test-passphrase" is used for local development only
    (echo "test-passphrase" | hc sandbox --piped generate \
        --in-process-lair \
        --run 0 \
        --app-id "$APP_ID" \
        --root "$HC_SANDBOX_DATADIR" \
        "$HAPP_PATH" \
        network -b "$BOOTSTRAP_URL" webrtc "$SIGNAL_URL" "$WEBRTC_CONFIG") \
        > sandbox-generate.log 2>&1 &

    CONDUCTOR_PID=$!
    echo "$CONDUCTOR_PID" > conductor.pid

    # Wait for conductor to start
    log_info "Waiting for conductor to start (PID: $CONDUCTOR_PID)..."
    for i in {1..60}; do
        # Check if conductor is ready - look for the JSON launch info
        if grep -q '"admin_port":' sandbox-generate.log 2>/dev/null; then
            log_info "Conductor started"

            # Get the admin port from the JSON output
            # Format: Conductor launched #!0 {"admin_port":41061,"app_ports":[38485]}
            ACTUAL_ADMIN=$(grep -oP '"admin_port":\K\d+' sandbox-generate.log 2>/dev/null | head -1)
            if [ -z "$ACTUAL_ADMIN" ]; then
                ACTUAL_ADMIN="$ADMIN_PORT"
            fi
            log_info "Admin interface on port: $ACTUAL_ADMIN"

            # Save the admin port and app ID for later use
            echo "$ACTUAL_ADMIN" > admin_port.txt
            echo "$APP_ID" > app_id.txt
            return 0
        fi
        # Check for errors in log
        if grep -q "^Error:" sandbox-generate.log 2>/dev/null; then
            log_error "Conductor failed with error:"
            cat sandbox-generate.log
            exit 1
        fi
        # Check if process is still running
        if ! kill -0 "$CONDUCTOR_PID" 2>/dev/null; then
            log_error "Conductor process died"
            cat sandbox-generate.log
            exit 1
        fi
        sleep 1
    done

    log_error "Conductor failed to start. Check sandbox-generate.log"
    cat sandbox-generate.log
    exit 1
}

# Start gateway
start_gateway() {
    log_info "Starting hc-http-gw..."

    # Check if gateway is already running (match the binary path, not just any command containing the string)
    if pgrep -f "target/release/hc-http-gw$" > /dev/null 2>&1; then
        log_warn "Gateway already running"
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

    # Build gateway if needed
    if [ ! -f "$GATEWAY_DIR/target/release/hc-http-gw" ]; then
        log_info "Building gateway..."
        (cd "$GATEWAY_DIR" && cargo build --release)
    fi

    # Start gateway with kitsune2 enabled for remote signal testing
    log_info "Starting gateway on port $GATEWAY_PORT (admin ws://localhost:$ACTUAL_ADMIN)..."

    # Get bootstrap/signal URLs from saved bootstrap address (local server)
    local BOOTSTRAP_URL
    local SIGNAL_URL
    if [ -f "$SANDBOX_DIR/bootstrap_addr.txt" ]; then
        local BOOTSTRAP_ADDR
        BOOTSTRAP_ADDR=$(cat "$SANDBOX_DIR/bootstrap_addr.txt")
        BOOTSTRAP_URL="http://${BOOTSTRAP_ADDR}"
        SIGNAL_URL="ws://${BOOTSTRAP_ADDR}"
    else
        # Fallback to public servers if local bootstrap not available
        BOOTSTRAP_URL="https://dev-test-bootstrap2.holochain.org/"
        SIGNAL_URL="wss://dev-test-bootstrap2.holochain.org/"
    fi
    log_info "Kitsune2 bootstrap: $BOOTSTRAP_URL"
    log_info "Kitsune2 signal: $SIGNAL_URL"

    # Configure allowed app IDs and functions based on hApp
    local ALLOWED_APP_IDS="$APP_ID"
    local ALLOWED_FNS_VAR="HC_GW_ALLOWED_FNS_${APP_ID}"

    log_info "Allowed app IDs: $ALLOWED_APP_IDS"

    # Export the allowed functions variable dynamically
    export "HC_GW_ALLOWED_FNS_${APP_ID}=*"

    HC_GW_ADMIN_WS_URL="ws://localhost:$ACTUAL_ADMIN" \
    HC_GW_PORT="$GATEWAY_PORT" \
    HC_GW_ALLOWED_APP_IDS="$ALLOWED_APP_IDS" \
    HC_GW_KITSUNE2_ENABLED="true" \
    HC_GW_BOOTSTRAP_URL="$BOOTSTRAP_URL" \
    HC_GW_SIGNAL_URL="$SIGNAL_URL" \
    RUST_LOG="info,holochain_http_gateway=debug" \
    "$GATEWAY_DIR/target/release/hc-http-gw" > gateway.log 2>&1 &

    GATEWAY_PID=$!
    echo "$GATEWAY_PID" > gateway.pid

    # Wait for gateway to start
    for i in {1..10}; do
        if curl -s "http://localhost:$GATEWAY_PORT/health" > /dev/null 2>&1; then
            log_info "Gateway started on port $GATEWAY_PORT"
            return 0
        fi
        sleep 1
    done

    # Check if process is still running
    if kill -0 "$GATEWAY_PID" 2>/dev/null; then
        log_info "Gateway started (health endpoint not responding, but process running)"
        return 0
    fi

    log_error "Gateway failed to start. Check gateway.log"
    cat gateway.log
    exit 1
}

# Stop services
stop_services() {
    log_info "Stopping services..."

    cd "$SANDBOX_DIR" 2>/dev/null || true

    # Stop gateway
    if [ -f gateway.pid ]; then
        GATEWAY_PID=$(cat gateway.pid)
        if kill -0 "$GATEWAY_PID" 2>/dev/null; then
            log_info "Stopping gateway (PID $GATEWAY_PID)..."
            kill "$GATEWAY_PID"
        fi
        rm -f gateway.pid
    fi

    # Stop conductor
    if [ -f conductor.pid ]; then
        CONDUCTOR_PID=$(cat conductor.pid)
        if kill -0 "$CONDUCTOR_PID" 2>/dev/null; then
            log_info "Stopping conductor (PID $CONDUCTOR_PID)..."
            kill "$CONDUCTOR_PID"
        fi
        rm -f conductor.pid
    fi
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

    # Check conductor - look for hc sandbox process or holochain with our sandbox dir
    if pgrep -f "hc sandbox" > /dev/null 2>&1 || pgrep -f "$SANDBOX_DIR" > /dev/null 2>&1; then
        echo -e "Conductor: ${GREEN}RUNNING${NC}"
    elif [ -f "$SANDBOX_DIR/sandbox-generate.log" ] && grep -q "running conductor" "$SANDBOX_DIR/sandbox-generate.log" 2>/dev/null; then
        echo -e "Conductor: ${GREEN}RUNNING${NC} (from log)"
    else
        echo -e "Conductor: ${RED}STOPPED${NC}"
    fi

    # Check gateway (match the binary path, not just any command containing the string)
    if pgrep -f "target/release/hc-http-gw$" > /dev/null 2>&1; then
        echo -e "Gateway:   ${GREEN}RUNNING${NC} on port $GATEWAY_PORT"
    else
        echo -e "Gateway:   ${RED}STOPPED${NC}"
    fi

    echo ""
    echo "Test URLs:"
    echo "  - Gateway: http://localhost:$GATEWAY_PORT"
    echo "  - Test page: file://$PROJECT_DIR/packages/extension/test/e2e-gateway-test.html"
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

# Initialize test entry on the gateway (for fixture1 only)
# Creates an entry with known content "fishy" that can be fetched by the browser extension
initialize_test_entry() {
    # Skip for happs that don't have a test entry function
    if [ -z "$TEST_FN" ]; then
        log_info "Skipping test entry initialization for $HAPP_NAME (no test function)"
        return 0
    fi

    log_info "Initializing test entry on gateway..."

    # Wait for gateway to be ready
    sleep 2

    cd "$SANDBOX_DIR"

    # Get the DNA hash from the sandbox using the saved admin port
    log_info "Getting DNA hash from sandbox..."

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

    log_info "Using admin port: $ACTUAL_ADMIN"

    local DNA_HASH
    # The output is a JSON array like: ["uhC0k..."]
    # Extract the first hash from the array
    DNA_HASH=$(hc sandbox call --running="$ACTUAL_ADMIN" list-dnas 2>&1 | grep -oP '"uhC0k[^"]+' | head -1 | tr -d '"')

    if [ -z "$DNA_HASH" ]; then
        log_warn "Could not get DNA hash from sandbox"
        log_info "You can manually call: hc sandbox call list-dnas"
        return 1
    fi

    log_info "DNA hash: $DNA_HASH"

    # Create an entry with known content "fishy"
    # The entry hash will be deterministic based on the content
    local PAYLOAD='{"value":"fishy"}'
    local ENCODED_PAYLOAD
    ENCODED_PAYLOAD=$(echo -n "$PAYLOAD" | base64 -w0)

    # Call the gateway to create the entry
    # Format: GET /{dna-hash}/{app-id}/{zome-name}/{fn-name}?payload={base64}
    # Note: The coordinator_identifier must be the app_id, not a numeric index
    log_info "Creating known entry with value 'fishy'..."

    local RESPONSE
    RESPONSE=$(curl -s "http://localhost:$GATEWAY_PORT/${DNA_HASH}/${APP_ID}/${COORDINATOR_ZOME}/${TEST_FN}?payload=$ENCODED_PAYLOAD" 2>&1)

    if echo "$RESPONSE" | grep -q "entry_hash"; then
        log_info "Test entry created successfully"

        # Extract and display the hashes
        local ACTION_HASH
        local ENTRY_HASH
        ACTION_HASH=$(echo "$RESPONSE" | grep -oP '"action_hash"\s*:\s*"\K[^"]+' || echo "unknown")
        ENTRY_HASH=$(echo "$RESPONSE" | grep -oP '"entry_hash"\s*:\s*"\K[^"]+' || echo "unknown")

        log_info "Action hash: $ACTION_HASH"
        log_info "Entry hash: $ENTRY_HASH"

        # Save for reference
        echo "$RESPONSE" > "$SANDBOX_DIR/known_entry.json"
        echo "$DNA_HASH" > "$SANDBOX_DIR/dna_hash.txt"
        log_info "Entry hashes saved to $SANDBOX_DIR/known_entry.json"
    else
        log_warn "Could not create test entry. Response: $RESPONSE"
        log_info "Gateway URL was: http://localhost:$GATEWAY_PORT/${DNA_HASH}/${APP_ID}/${COORDINATOR_ZOME}/${TEST_FN}"
    fi
}

# Get and save DNA hash (for happs without test entry)
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
        # Give conductor time to fully initialize
        sleep 2
        start_gateway
        show_status
        echo ""
        # Initialize test entry (or just save DNA hash)
        if [ -n "$TEST_FN" ]; then
            initialize_test_entry
        else
            save_dna_hash
        fi

        echo ""
        echo "To test, open in browser:"
        if [ "$HAPP_NAME" = "ziptest" ]; then
            echo "  Navigate to your ziptest UI (served separately)"
            echo "  Configure the extension with gateway URL: http://localhost:$GATEWAY_PORT"
            if [ -f "$SANDBOX_DIR/dna_hash.txt" ]; then
                echo "  Conductor DNA hash: $(cat "$SANDBOX_DIR/dna_hash.txt")"
                echo "  (Extension should compute the same hash - no override needed)"
            fi
        else
            echo "  file://$PROJECT_DIR/packages/extension/test/e2e-gateway-test.html"
        fi
        echo ""
        echo "Press Ctrl+C or run './scripts/e2e-test-setup.sh stop' to stop services"
        ;;
    stop)
        stop_services
        ;;
    status)
        show_status
        ;;
    clean)
        clean_sandbox
        ;;
    *)
        echo "Usage: $0 {start|stop|status|clean} [--happ=NAME]"
        echo ""
        echo "Options:"
        echo "  --happ=NAME   Specify which hApp to use (fixture1 or ziptest, default: fixture1)"
        echo ""
        echo "Examples:"
        echo "  $0 start                    # Start with fixture1"
        echo "  $0 start --happ=ziptest     # Start with ziptest"
        echo "  $0 stop"
        exit 1
        ;;
esac
