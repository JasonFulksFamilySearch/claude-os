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

# ── Step 3: Hook registrations in settings.json ──────────────────────────────

echo "--- Step 3: Hook registrations ---"

SETTINGS="$HOME/.claude/settings.json"

if [ ! -f "$SETTINGS" ]; then
    skip "settings.json not found — skipping hook registration"
else
    if ! command -v jq &>/dev/null; then
        skip "jq not installed — skipping hook registration (install jq to automate this)"
    else
        TMP_SETTINGS=$(mktemp)

        # UserPromptSubmit hook
        if jq -e '.hooks | has("UserPromptSubmit")' "$SETTINGS" >/dev/null 2>&1; then
            skip "UserPromptSubmit hook already registered"
        else
            jq '.hooks.UserPromptSubmit = [{"hooks":[{"type":"command","command":"node ~/.claude-os/hooks/topic-preload.js","statusMessage":"Scanning for topic context..."}]}]' \
                "$SETTINGS" > "$TMP_SETTINGS" && mv "$TMP_SETTINGS" "$SETTINGS"
            ok "Registered UserPromptSubmit hook (topic-preload)"
        fi

        # Stop hook
        if jq -e '.hooks | has("Stop")' "$SETTINGS" >/dev/null 2>&1; then
            skip "Stop hook already registered"
        else
            jq '.hooks.Stop = [{"hooks":[{"type":"command","command":"node ~/.claude-os/hooks/learnings-flush.js","statusMessage":"Flushing pending learnings..."}]}]' \
                "$SETTINGS" > "$TMP_SETTINGS" && mv "$TMP_SETTINGS" "$SETTINGS"
            ok "Registered Stop hook (learnings-flush)"
        fi

        rm -f "$TMP_SETTINGS"
    fi
fi

echo ""

# ── Step 4: CLAUDE.md operating rules check ──────────────────────────────────

echo "--- Step 4: CLAUDE.md operating rules ---"

CLAUDE_MD="$HOME/.claude-data/agent/CLAUDE.md"

if [ ! -f "$CLAUDE_MD" ]; then
    skip "~/.claude-data/agent/CLAUDE.md not found"
elif grep -qF "Read the index file at" "$CLAUDE_MD"; then
    echo -e "${YELLOW}[WARN]${NC}  CLAUDE.md still has pre-Phase-3 operating rules."
    echo ""
    echo "  Replace this rule:"
    echo "    - Read the index file at \`~/.claude-data/context/_index.md\` ..."
    echo ""
    echo "  With these two rules:"
    echo "    - When the \`UserPromptSubmit\` hook injects a \`[Context hint]\` tag, evaluate"
    echo "      whether the matched topics are relevant and load them via"
    echo "      \`mcp__claude-os-mcp__get_topic\`. The hook handles detection; the agent handles"
    echo "      the relevance judgment. Reading \`_index.md\` manually is no longer needed."
    echo "    - When a session produces a non-obvious lesson, correction, or decision: write"
    echo "      it to \`~/.claude-data/_tmp_pending_learning.json\` as a JSON array entry"
    echo "      { \"scope\": \"agent\"|\"project\", \"title\": \"...\", \"content\": \"...\", \"project\"?: \"...\" }."
    echo "      Do this during the session when the insight occurs — not only at the end."
    echo "      The Stop hook delivers all pending entries at session close. For immediate"
    echo "      or manual capture, \`mcp__claude-os-mcp__append_learning\` still works directly."
    echo ""
else
    ok "CLAUDE.md operating rules are up to date"
fi

echo ""

# ── Done ──────────────────────────────────────────────────────────────────────

echo "================================================"
echo " Update complete"
echo "================================================"
echo ""
ok "Skills and commands are live (symlinks). Restart Claude Code if the MCP server was rebuilt."
echo ""
