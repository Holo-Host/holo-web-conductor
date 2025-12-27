#!/bin/bash
# Simple HTTP server for testing
# Run this script, then open http://localhost:8080/wasm-test.html

echo "Starting test server on http://localhost:8080"
echo "Open http://localhost:8080/wasm-test.html in your browser"
echo "Press Ctrl+C to stop"
echo ""

# Use Python's built-in HTTP server
if command -v python3 &> /dev/null; then
    python3 -m http.server 8080
elif command -v python &> /dev/null; then
    python -m SimpleHTTPServer 8080
else
    echo "Error: Python not found. Install Python or use another HTTP server."
    exit 1
fi
