#!/bin/bash
# Multi-port HTTP server for testing different hApps
# Each port = different origin = isolated hApp context

WASM_PORT=8080
PROFILES_PORT=8081

cleanup() {
    echo ""
    echo "Stopping servers..."
    kill $WASM_PID 2>/dev/null
    kill $PROFILES_PID 2>/dev/null
    exit 0
}

trap cleanup SIGINT SIGTERM

echo "Starting test servers..."
echo ""
echo "  wasm-test:     http://localhost:$WASM_PORT/wasm-test.html"
echo "  profiles-test: http://localhost:$PROFILES_PORT/profiles-test.html"
echo ""
echo "Each port is a separate origin with isolated hApp context."
echo "Press Ctrl+C to stop all servers."
echo ""

# Start servers in background
if command -v python3 &> /dev/null; then
    python3 -m http.server $WASM_PORT &
    WASM_PID=$!
    python3 -m http.server $PROFILES_PORT &
    PROFILES_PID=$!
elif command -v python &> /dev/null; then
    python -m SimpleHTTPServer $WASM_PORT &
    WASM_PID=$!
    python -m SimpleHTTPServer $PROFILES_PORT &
    PROFILES_PID=$!
else
    echo "Error: Python not found. Install Python or use another HTTP server."
    exit 1
fi

echo "Servers running (PIDs: $WASM_PID, $PROFILES_PID)"
echo ""

# Wait for either to exit
wait
