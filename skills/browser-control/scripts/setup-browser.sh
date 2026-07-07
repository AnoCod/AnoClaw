#!/bin/bash
# setup-browser.sh — Start Chrome/Chromium with remote debugging port 9222
# Usage: bash setup-browser.sh [chrome|chromium|edge]

set -e

BROWSER="${1:-chrome}"
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${YELLOW}🔄 Killing existing browser processes...${NC}"

case $BROWSER in
  chrome)
    killall "Google Chrome" 2>/dev/null || true
    sleep 2
    CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    if [ ! -f "$CHROME_PATH" ]; then
      CHROME_PATH="google-chrome"
    fi
    echo -e "${GREEN}🚀 Starting Chrome with remote debugging...${NC}"
    "$CHROME_PATH" --remote-debugging-port=9222 &
    ;;
  chromium)
    killall "Chromium" 2>/dev/null || true
    sleep 2
    echo -e "${GREEN}🚀 Starting Chromium with remote debugging...${NC}"
    chromium --remote-debugging-port=9222 &
    ;;
  edge)
    killall "Microsoft Edge" 2>/dev/null || true
    sleep 2
    EDGE_PATH="/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
    if [ ! -f "$EDGE_PATH" ]; then
      EDGE_PATH="microsoft-edge"
    fi
    echo -e "${GREEN}🚀 Starting Edge with remote debugging...${NC}"
    "$EDGE_PATH" --remote-debugging-port=9222 &
    ;;
  *)
    echo -e "${RED}Unknown browser: $BROWSER${NC}"
    echo "Usage: bash setup-browser.sh [chrome|chromium|edge]"
    exit 1
    ;;
esac

sleep 3

# Verify
if curl -s http://localhost:9222/json/version > /dev/null 2>&1; then
  echo -e "${GREEN}✅ Browser started successfully on port 9222${NC}"
  echo ""
  echo -e "${CYAN}Now you can run:${NC}"
  echo "  node scripts/cdp-navigate.js \"https://example.com\""
  echo "  node scripts/cdp-extract.js"
  echo "  node scripts/cdp-chat.js \"your question\""
  echo "  node scripts/cdp-network.js --duration 10"
else
  echo -e "${YELLOW}⚠️  Port 9222 not listening yet. Wait a moment and try again.${NC}"
fi
