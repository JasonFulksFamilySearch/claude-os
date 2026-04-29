#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

ok()   { echo -e "${GREEN}[OK]${NC}   $1"; }
skip() { echo -e "${YELLOW}[SKIP]${NC} $1"; }
fail() { echo -e "${RED}[FAIL]${NC} $1"; exit 1; }

echo ""
echo "================================================"
echo " claude-os update"
echo "================================================"
echo ""

# ── Step 1: Pull latest ───────────────────────────────────────────────────────

echo "--- Step 1: git pull ---"

cd "$REPO_DIR"

MCP_TREE_BEFORE=$(git rev-parse HEAD:mcp 2>/dev/null || echo "none")

git pull --ff-only || fail "Pull failed. Resolve conflicts manually, then re-run."

MCP_TREE_AFTER=$(git rev-parse HEAD:mcp 2>/dev/null || echo "none")

ok "Pulled latest"
echo ""

# ── Step 2: Rebuild MCP server if mcp/ changed ───────────────────────────────

echo "--- Step 2: MCP server ---"

if [ "$MCP_TREE_BEFORE" = "$MCP_TREE_AFTER" ]; then
    skip "mcp/ unchanged — skipping build"
else
    echo "  mcp/ changed — rebuilding..."
    cd "$REPO_DIR/mcp"
    npm install --silent
    npm run build --silent 2>/dev/null || npm run build
    ok "MCP server rebuilt"
fi

echo ""

# ── Done ──────────────────────────────────────────────────────────────────────

echo "================================================"
echo " Update complete"
echo "================================================"
echo ""
ok "Skills and commands are live (symlinks). Restart Claude Code if the MCP server was rebuilt."
echo ""
