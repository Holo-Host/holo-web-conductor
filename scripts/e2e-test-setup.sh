#!/usr/bin/env bash
#
# End-to-End Test Setup Script
#
# This script sets up the environment for end-to-end testing of the fishy
# extension with a real Holochain conductor and gateway.
#
# Usage:
#   ./scripts/e2e-test-setup.sh [command]
#
# Commands:
#   start     Start conductor and gateway (default)
#   stop      Stop all services
#   status    Show running services
#   clean     Clean up sandbox data
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
GATEWAY_DIR="$(cd "$PROJECT_DIR/../hc-http-gw-fork" && pwd)"
SANDBOX_DIR="$PROJECT_DIR/.hc-sandbox"
HAPP_PATH="$GATEWAY_DIR/fixture/package/happ1/fixture1.happ"

# Ports
ADMIN_PORT=8888
APP_PORT=8889
GATEWAY_PORT=8090

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
        log_warn "hApp not found at $HAPP_PATH"
        log_info "Building fixture hApp..."
        (cd "$GATEWAY_DIR/fixture" && RUSTFLAGS='--cfg getrandom_backend="custom"' cargo build --release --target wasm32-unknown-unknown && ./package.sh)
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
    log_info "Generating sandbox with fixture hApp..."

    # Use a directory in the sandbox dir to avoid /tmp issues
    export HC_SANDBOX_DATADIR="$SANDBOX_DIR/data"
    mkdir -p "$HC_SANDBOX_DATADIR"

    # Always use in-process lair to avoid passphrase issues
    log_info "Using in-process lair (no external lair-keystore needed)"

    # Generate and run sandbox in one step using --run
    # --piped is a GLOBAL option that must come BEFORE the subcommand
    log_info "Running: hc sandbox --piped generate --in-process-lair --run 0 --app-id fixture1 ..."

    # Run in background, piping passphrase via stdin
    # The passphrase "test-passphrase" is used for local development only
    (echo "test-passphrase" | hc sandbox --piped generate \
        --in-process-lair \
        --run 0 \
        --app-id fixture1 \
        --root "$HC_SANDBOX_DATADIR" \
        "$HAPP_PATH") \
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

            # Save the admin port for later use
            echo "$ACTUAL_ADMIN" > admin_port.txt
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

    # Start gateway
    log_info "Starting gateway on port $GATEWAY_PORT (admin ws://localhost:$ACTUAL_ADMIN)..."

    HC_GW_ADMIN_WS_URL="ws://localhost:$ACTUAL_ADMIN" \
    HC_GW_PORT="$GATEWAY_PORT" \
    HC_GW_ALLOWED_APP_IDS="fixture1" \
    HC_GW_ALLOWED_FNS_fixture1="*" \
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

    log_info "Services stopped"
}

# Show status
show_status() {
    echo ""
    echo "=== E2E Test Environment Status ==="
    echo ""

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

# Initialize test entry on the gateway
# Creates an entry with known content "fishy" that can be fetched by the browser extension
initialize_test_entry() {
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
    RESPONSE=$(curl -s "http://localhost:$GATEWAY_PORT/${DNA_HASH}/fixture1/coordinator1/create_known_entry?payload=$ENCODED_PAYLOAD" 2>&1)

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
        log_info "Gateway URL was: http://localhost:$GATEWAY_PORT/${DNA_HASH}/fixture1/coordinator1/create_known_entry"
    fi
}

# Main command handling
case "${1:-start}" in
    start)
        check_prereqs
        start_conductor
        # Give conductor time to fully initialize
        sleep 2
        start_gateway
        show_status
        echo ""
        # Initialize test entry
        initialize_test_entry

        echo ""
        echo "To test, open in browser:"
        echo "  file://$PROJECT_DIR/packages/extension/test/e2e-gateway-test.html"
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
        echo "Usage: $0 {start|stop|status|clean}"
        exit 1
        ;;
esac
