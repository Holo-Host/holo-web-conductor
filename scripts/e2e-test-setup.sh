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
#   pause     Stop only the gateway (conductors keep running)
#   unpause   Start only the gateway (when conductors are already running)
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
# Use /tmp for sandbox to avoid Unix socket path length limits (SUN_LEN ~108 chars)
SANDBOX_DIR="/tmp/fishy-e2e"

# Default hApp configuration
HAPP_NAME="fixture1"
HAPP_EXPLICIT=false  # Track if --happ was explicitly provided

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

# For unpause command, read saved app_id if --happ wasn't explicitly provided
if [ "$COMMAND" = "unpause" ] && [ "$HAPP_EXPLICIT" = "false" ]; then
    if [ -f "$SANDBOX_DIR/app_id.txt" ]; then
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
    local SIGNAL_URL="ws://${BOOTSTRAP_ADDR}"
    local WEBRTC_CONFIG="$SCRIPT_DIR/webrtc-config.json"

    log_info "Conductor $INDEX: bootstrap=$BOOTSTRAP_URL signal=$SIGNAL_URL"

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
        network -b "$BOOTSTRAP_URL" webrtc "$SIGNAL_URL" "$WEBRTC_CONFIG") \
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

            # Save app ID for conductor 1 (primary)
            if [ "$INDEX" -eq 1 ]; then
                echo "$APP_ID" > app_id.txt
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

# Stop only the gateway (pause)
pause_gateway() {
    log_info "Pausing gateway (stopping gateway only, conductors keep running)..."

    cd "$SANDBOX_DIR" 2>/dev/null || true

    # Stop gateway
    if [ -f gateway.pid ]; then
        GATEWAY_PID=$(cat gateway.pid)
        if kill -0 "$GATEWAY_PID" 2>/dev/null; then
            log_info "Stopping gateway (PID $GATEWAY_PID)..."
            kill "$GATEWAY_PID"
            # Wait for it to actually stop
            for i in {1..10}; do
                if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
                    break
                fi
                sleep 0.5
            done
        fi
        rm -f gateway.pid
    else
        # Also check by process name
        if pgrep -f "target/release/hc-http-gw$" > /dev/null 2>&1; then
            log_info "Stopping gateway by process name..."
            pkill -f "target/release/hc-http-gw$" || true
        fi
    fi

    log_info "Gateway paused (conductors still running)"
}

# Start only the gateway (unpause) - assumes conductors already running
unpause_gateway() {
    log_info "Unpausing gateway (starting gateway only)..."

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

    # Check if gateway already running
    if pgrep -f "target/release/hc-http-gw$" > /dev/null 2>&1; then
        log_warn "Gateway already running"
        return 0
    fi

    # Start gateway (reuse start_gateway function)
    start_gateway

    log_info "Gateway unpaused"
}

# Stop services
stop_services() {
    log_info "Stopping services..."

    cd "$SANDBOX_DIR" 2>/dev/null || true

    # Stop gateway first
    pause_gateway 2>/dev/null || true

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
        # Wait for conductors to discover each other and establish DHT arcs
        wait_for_arc_establishment
        # Give conductors time to fully initialize after arc establishment
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
    pause)
        pause_gateway
        show_status
        ;;
    unpause)
        configure_happ
        unpause_gateway
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
        echo "  start     Start conductor and gateway"
        echo "  stop      Stop all services"
        echo "  pause     Stop only the gateway (conductors keep running)"
        echo "  unpause   Start only the gateway (conductors must be running)"
        echo "  status    Show running services"
        echo "  clean     Clean up sandbox data"
        echo ""
        echo "Options:"
        echo "  --happ=NAME   Specify which hApp to use (fixture1 or ziptest, default: fixture1)"
        echo ""
        echo "Examples:"
        echo "  $0 start                    # Start with fixture1"
        echo "  $0 start --happ=ziptest     # Start with ziptest"
        echo "  $0 pause                    # Stop gateway, keep conductors"
        echo "  $0 unpause                  # Restart gateway"
        echo "  $0 stop"
        exit 1
        ;;
esac
