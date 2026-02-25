#!/bin/bash
# Serve manual test pages on http://localhost:8080
#
# Usage:
#   ./scripts/serve-test-pages.sh
#
# Then open one of:
#   http://localhost:8080/sandbox-test.html        (extension API tests, no linker)
#   http://localhost:8080/happ-test.html           (client library tests, no linker)
#   http://localhost:8080/authorization-test.html  (auth popup flow)
#   http://localhost:8080/membrane-proof-test.html (deferred membrane proof flow)

cd "$(dirname "$0")/../packages/extension/test" || exit 1
echo "Serving test pages at http://localhost:8080"
echo "  sandbox-test.html        - Extension API + all host function tests"
echo "  happ-test.html           - WebConductorAppClient integration"
echo "  authorization-test.html  - Auth popup grant/revoke cycle"
echo "  membrane-proof-test.html - Deferred membrane proof flow"
echo ""
python3 -m http.server 8080
