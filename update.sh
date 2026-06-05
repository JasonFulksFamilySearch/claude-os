#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

ok()   { echo -e "${GREEN}[OK]${NC}   $1"; }
skip() { echo -e "${YELLOW}[SKIP]${NC} $1"; }
warn() { echo -e "${YELLOW}[!!]${NC}   $1"; }
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
elif node "$REPO_DIR/hooks/hooks-install.js"; then
    ok "Lifecycle hooks reconciled in settings.json"
else
    warn "Hook registration failed — run manually: node $REPO_DIR/hooks/hooks-install.js"
fi

echo ""

# ── Step 4: CLAUDE.md operating rules check ──────────────────────────────────

echo "--- Step 4: CLAUDE.md operating rules ---"

CLAUDE_MD="$HOME/.claude-data/agent/CLAUDE.md"
CLAUDE_MD_MARKER="$HOME/.claude-data/_tmp_claude_md_update_needed.txt"

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
    # Write marker so the SessionStart hook can surface this inside a Claude session
    cat > "$CLAUDE_MD_MARKER" <<'MARKER_EOF'
Your CLAUDE.md still has pre-Phase-3 operating rules. Please make the following change:

Replace this rule:
  - Read the index file at `~/.claude-data/context/_index.md` ...

With these two rules:
  - When the `UserPromptSubmit` hook injects a `[Context hint]` tag, evaluate
    whether the matched topics are relevant and load them via
    `mcp__claude-os-mcp__get_topic`. The hook handles detection; the agent handles
    the relevance judgment. Reading `_index.md` manually is no longer needed.
  - When a session produces a non-obvious lesson, correction, or decision: write
    it to `~/.claude-data/_tmp_pending_learning.json` as a JSON array entry
    { "scope": "agent"|"project", "title": "...", "content": "...", "project"?: "..." }.
    Do this during the session when the insight occurs — not only at the end.
    The Stop hook delivers all pending entries at session close. For immediate
    or manual capture, `mcp__claude-os-mcp__append_learning` still works directly.

Once updated, delete this marker file: ~/.claude-data/_tmp_claude_md_update_needed.txt
MARKER_EOF
    ok "Wrote update marker → ~/.claude-data/_tmp_claude_md_update_needed.txt"
else
    ok "CLAUDE.md operating rules are up to date"
    rm -f "$CLAUDE_MD_MARKER"
fi

echo ""

# ── Step 5: Cleanup stale paths ──────────────────────────────────────────────

echo "--- Step 5: Cleanup stale paths ---"

# agents/ should be a symlink like skills/ and commands/ — convert if still a plain directory
if [ -d "$HOME/.claude/agents" ] && [ ! -L "$HOME/.claude/agents" ]; then
    rm -rf "$HOME/.claude/agents"
    ln -s "$HOME/.claude-os/agents" "$HOME/.claude/agents"
    ok "Converted ~/.claude/agents → symlink to ~/.claude-os/agents"
else
    skip "~/.claude/agents already a symlink"
fi

# Remove directories superseded by the claude-os migration
for stale in \
    "$HOME/.claude/memory" \
    "$HOME/.claude/agent-memory" \
    "$HOME/.claude/backups"
do
    if [ -e "$stale" ]; then
        rm -rf "$stale"
        ok "Removed stale: $(basename $stale)/"
    else
        skip "Already gone: $(basename $stale)/"
    fi
done

# Remove pre-cutover backup files
for f in \
    "$HOME/.claude/CLAUDE.md.pre-claude-os" \
    "$HOME/.claude/commands.pre-claude-os" \
    "$HOME/.claude/skills.pre-claude-os" \
    "$HOME/.claude/CLAUDE.md.backup-"*
do
    if [ -e "$f" ]; then
        rm -rf "$f"
        ok "Removed: $(basename $f)"
    fi
done

echo ""

# ── Step 6: Episode pruning ──────────────────────────────────────────────────

echo "--- Step 6: Episode pruning ---"

EPISODES_DIR="$HOME/.claude-data/episodes"
MAX_EPISODES=200
RETENTION_DAYS=90

if [ ! -d "$EPISODES_DIR" ]; then
    skip "Episodes directory not found — skipping pruning"
else
    # Delete files older than RETENTION_DAYS
    AGED_OUT=$(find "$EPISODES_DIR" -name "*.md" -mtime +"$RETENTION_DAYS" 2>/dev/null | wc -l | tr -d ' ')
    if [ "$AGED_OUT" -gt 0 ]; then
        find "$EPISODES_DIR" -name "*.md" -mtime +"$RETENTION_DAYS" -delete
        ok "Pruned $AGED_OUT episodes older than ${RETENTION_DAYS} days"
    fi

    # Also enforce max count by deleting oldest beyond MAX_EPISODES
    REMAINING=$(ls "$EPISODES_DIR"/*.md 2>/dev/null | wc -l | tr -d ' ')
    if [ "$REMAINING" -gt "$MAX_EPISODES" ]; then
        EXCESS=$((REMAINING - MAX_EPISODES))
        ls "$EPISODES_DIR"/*.md 2>/dev/null | sort | head -n "$EXCESS" | xargs rm -f
        ok "Pruned $EXCESS oldest episodes (capped at $MAX_EPISODES total)"
    else
        skip "Episode count ($REMAINING) within limit ($MAX_EPISODES) — no pruning needed"
    fi
fi

echo ""

# ── Step 7: Context templates ─────────────────────────────────────────────────

echo "--- Step 7: Context templates ---"

TEMPLATES_DIR="$REPO_DIR/context-templates"
CONTEXT_DIR="$HOME/.claude-data/context"

if [ ! -d "$TEMPLATES_DIR" ]; then
    skip "No context-templates/ directory — skipping"
else
    mkdir -p "$CONTEXT_DIR"
    PROVISIONED=0
    for template in "$TEMPLATES_DIR"/*.md; do
        [ -f "$template" ] || continue
        target="$CONTEXT_DIR/$(basename "$template")"
        if [ ! -f "$target" ]; then
            cp "$template" "$target"
            ok "Provisioned context: $(basename "$target")"
            PROVISIONED=$((PROVISIONED + 1))
        else
            skip "Context already exists: $(basename "$target")"
        fi
    done
fi

echo ""

# ── Step 8: User-scoped rule templates ────────────────────────────────────────

echo "--- Step 8: Rule templates ---"

RULES_TEMPLATES_DIR="$REPO_DIR/templates/rules"
RULES_DST_DIR="$HOME/.claude/rules"
IDENTITY_FILE="$HOME/.claude/CLAUDE.md"

if [ ! -d "$RULES_TEMPLATES_DIR" ]; then
    skip "No templates/rules/ directory — skipping"
elif [ ! -f "$IDENTITY_FILE" ]; then
    skip "No identity file at $IDENTITY_FILE — cannot resolve \${AGENT_NAME}/\${USER_NAME}, skipping rule render"
else
    # Derive identity from the already-rendered user CLAUDE.md. install.sh prompts
    # for these and bakes them into the identity file but persists no env file, so
    # update.sh recovers them here from the canonical anchors:
    #   line 1:  "# Agent Identity — <AGENT_NAME>"
    #   line 3:  "You are <USER_NAME>'s agent on the <machine>."
    AGENT_NAME=$(sed -n 's/^# Agent Identity — \(.*\)$/\1/p' "$IDENTITY_FILE" | head -n1)
    USER_NAME=$(sed -n "s/^You are \(.*\)'s agent on .*/\1/p" "$IDENTITY_FILE" | head -n1)

    if [ -z "$AGENT_NAME" ] || [ -z "$USER_NAME" ]; then
        warn "Could not derive AGENT_NAME/USER_NAME from $IDENTITY_FILE — skipping rule render"
    elif ! command -v envsubst >/dev/null 2>&1; then
        warn "envsubst not found (install via: brew install gettext) — skipping rule render"
    else
        export AGENT_NAME USER_NAME
        mkdir -p "$RULES_DST_DIR"
        RENDERED=0
        for template in "$RULES_TEMPLATES_DIR"/*.md; do
            [ -f "$template" ] || continue
            target="$RULES_DST_DIR/$(basename "$template")"
            envsubst '${AGENT_NAME} ${USER_NAME}' < "$template" > "$target"
            ok "Rendered rule: $(basename "$target") (AGENT_NAME=$AGENT_NAME, USER_NAME=$USER_NAME)"
            RENDERED=$((RENDERED + 1))
        done
        [ "$RENDERED" -eq 0 ] && skip "No *.md templates in templates/rules/"
    fi
fi

echo ""

# ── Done ──────────────────────────────────────────────────────────────────────

echo "================================================"
echo " Update complete"
echo "================================================"
echo ""
ok "Skills and commands are live (symlinks). Restart Claude Code if the MCP server was rebuilt."
echo ""
