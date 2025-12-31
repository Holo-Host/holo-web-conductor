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

    # Check if conductor is already running
    if pgrep -f "holochain.*$ADMIN_PORT" > /dev/null 2>&1; then
        log_warn "Conductor already running on port $ADMIN_PORT"
        return 0
    fi

    # Clean up old sandbox
    rm -rf .hc conductor-* *.yaml 2>/dev/null || true

    # Generate a new sandbox with the hApp
    log_info "Generating sandbox with fixture hApp..."
    hc sandbox generate \
        --in-process-lair \
        --run 0 \
        --app-id fixture1 \
        "$HAPP_PATH" \
        2>&1 | tee sandbox-generate.log &

    # Wait for conductor to start
    log_info "Waiting for conductor to start..."
    for i in {1..30}; do
        if curl -s "http://localhost:$ADMIN_PORT" > /dev/null 2>&1 || \
           grep -q "Conductor ready" sandbox-generate.log 2>/dev/null; then
            log_info "Conductor started"

            # Get the admin port from the log
            ACTUAL_ADMIN=$(grep -oP "Admin Interfaces:\s*\K\d+" sandbox-generate.log 2>/dev/null || echo "$ADMIN_PORT")
            log_info "Admin interface on port: $ACTUAL_ADMIN"
            return 0
        fi
        sleep 1
    done

    log_error "Conductor failed to start. Check sandbox-generate.log"
    exit 1
}

# Start gateway
start_gateway() {
    log_info "Starting hc-http-gw..."

    # Check if gateway is already running
    if pgrep -f "hc-http-gw" > /dev/null 2>&1; then
        log_warn "Gateway already running"
        return 0
    fi

    # Get the actual admin port from the sandbox
    cd "$SANDBOX_DIR"
    ACTUAL_ADMIN=$(grep -oP "Admin Interfaces:\s*\K\d+" sandbox-generate.log 2>/dev/null || echo "$ADMIN_PORT")

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

    # Check gateway
    if pgrep -f "hc-http-gw" > /dev/null 2>&1; then
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
    log_info "Cleanup complete"
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
