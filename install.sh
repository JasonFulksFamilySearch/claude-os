#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
DATA_DIR="$HOME/.claude-data"

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
echo " claude-os install"
echo "================================================"
echo ""

# ── Step 1: Prerequisites ─────────────────────────────────────────────────────

echo "--- Step 1: Prerequisites ---"

NODE_VERSION=$(node --version 2>/dev/null | sed 's/v//' || echo "0")
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 24 ]; then
    fail "Node.js >= 24.0.0 required (found: ${NODE_VERSION:-none}). Install via https://nodejs.org or nvm."
fi
ok "Node.js v$NODE_VERSION"

command -v npm  >/dev/null 2>&1 || fail "npm not found. Install Node.js >= 24."
ok "npm $(npm --version)"

command -v git  >/dev/null 2>&1 || fail "git not found."
ok "git $(git --version | awk '{print $3}')"

command -v claude >/dev/null 2>&1 || warn "claude CLI not found — MCP registration will be skipped."
HAVE_CLAUDE=$(command -v claude >/dev/null 2>&1 && echo "yes" || echo "no")

# macOS: warn if xcode-select is missing (needed by better-sqlite3)
if [ "$(uname)" = "Darwin" ] && ! xcode-select -p >/dev/null 2>&1; then
    warn "Xcode Command Line Tools not found. better-sqlite3 may fail to build."
    warn "Fix with: xcode-select --install"
fi

echo ""

# ── Step 1.5: Dev root ────────────────────────────────────────────────────────

echo "--- Step 1.5: Dev root ---"

default_dev="$HOME/dev"
read -rp "Where are your dev projects? [$default_dev]: " input_dev
DEV_ROOT="${input_dev:-$default_dev}"
export DEV_ROOT

config_src="$REPO_DIR/config/watched-projects.template.json"
config_out="$REPO_DIR/config/watched-projects.json"

if [ -f "$config_out" ]; then
    skip "watched-projects.json already exists — delete it to regenerate"
elif command -v envsubst >/dev/null 2>&1; then
    envsubst '${DEV_ROOT}' < "$config_src" > "$config_out"
    ok "Generated watched-projects.json with DEV_ROOT=$DEV_ROOT"
else
    warn "envsubst not found (install via: brew install gettext)"
    warn "Manually copy config/watched-projects.template.json → config/watched-projects.json"
    warn "and replace \${DEV_ROOT} with: $DEV_ROOT"
fi

# Remove from git tracking if still indexed (safe — file is gitignored)
if git -C "$REPO_DIR" ls-files --error-unmatch config/watched-projects.json >/dev/null 2>&1; then
    git -C "$REPO_DIR" rm --cached config/watched-projects.json
    ok "Removed config/watched-projects.json from git index"
fi

echo ""

# ── Step 1.6: Agent identity ──────────────────────────────────────────────────

echo "--- Step 1.6: Agent identity ---"

read -rp "Your name (how the agent will refer to you) [human user]: " input_user
USER_NAME="${input_user:-human user}"
read -rp "Agent name for this machine [Claude]: " input_agent
AGENT_NAME="${input_agent:-Claude}"
read -rp "Description of this machine [Mac]: " input_machine
MACHINE_DESC="${input_machine:-Mac}"
export USER_NAME AGENT_NAME MACHINE_DESC

ok "Identity: $AGENT_NAME on $MACHINE_DESC, serving $USER_NAME"

echo ""

# ── Step 2: Build the MCP server ─────────────────────────────────────────────

echo "--- Step 2: MCP server build ---"

cd "$REPO_DIR/mcp"
rm -f package-lock.json
npm install --no-audit || fail "npm install failed in $REPO_DIR/mcp"
ok "npm install"
npm run build || fail "MCP server build failed — check TypeScript errors above"
[ -f "dist/index.js" ] || fail "Build succeeded but dist/index.js not found"
ok "MCP server built → $REPO_DIR/mcp/dist/index.js"

echo ""

# ── Step 3: ~/.claude-data/ scaffold ─────────────────────────────────────────

echo "--- Step 3: ~/.claude-data/ scaffold ---"

for d in agent context projects archive; do
    if [ -d "$DATA_DIR/$d" ]; then
        skip "$DATA_DIR/$d already exists"
    else
        mkdir -p "$DATA_DIR/$d"
        ok "Created $DATA_DIR/$d"
    fi
done

echo ""

# ── Step 4: Seed empty files (never overwrite) ────────────────────────────────

echo "--- Step 4: Seed files ---"

seed_file() {
    local path="$1"
    if [ -f "$path" ]; then
        skip "$path already exists"
    else
        touch "$path"
        ok "Seeded $path"
    fi
}

seed_file "$DATA_DIR/agent/learnings.md"
seed_file "$DATA_DIR/context/_index.md"

claude_md_dst="$DATA_DIR/agent/CLAUDE.md"
claude_md_src="$REPO_DIR/templates/CLAUDE.md"

# Render if missing OR zero-byte (empty file is an artifact of an earlier install
# that lacked a template; safe to overwrite).
if [ -f "$claude_md_dst" ] && [ -s "$claude_md_dst" ]; then
    skip "$claude_md_dst already exists"
elif [ ! -f "$claude_md_src" ]; then
    touch "$claude_md_dst"
    warn "No template at $claude_md_src — created empty $claude_md_dst (populate before use)"
elif command -v envsubst >/dev/null 2>&1; then
    envsubst '${USER_NAME} ${AGENT_NAME} ${MACHINE_DESC}' < "$claude_md_src" > "$claude_md_dst"
    ok "Rendered CLAUDE.md template → $claude_md_dst (USER_NAME=$USER_NAME, AGENT_NAME=$AGENT_NAME, MACHINE_DESC=$MACHINE_DESC)"
else
    cp "$claude_md_src" "$claude_md_dst"
    warn "envsubst not found — copied template literally; replace \${USER_NAME}=$USER_NAME, \${AGENT_NAME}=$AGENT_NAME, and \${MACHINE_DESC}=$MACHINE_DESC manually in $claude_md_dst"
fi

echo ""

# ── Step 5: Symlinks ──────────────────────────────────────────────────────────

echo "--- Step 5: Symlinks ---"

symlink_path() {
    local target="$1"    # source path inside the repo or data dir
    local link="$2"      # destination path under ~/.claude

    if [ -L "$link" ]; then
        CURRENT=$(readlink "$link")
        if [ "$CURRENT" = "$target" ]; then
            skip "$link → $target (already correct)"
        else
            warn "$link points to $CURRENT — updating to $target"
            rm "$link"
            ln -s "$target" "$link"
            ok "$link → $target"
        fi
    elif [ -e "$link" ]; then
        mv "$link" "${link}.pre-claude-os"
        ok "Backed up $link to ${link}.pre-claude-os"
        ln -s "$target" "$link"
        ok "$link → $target"
    else
        ln -s "$target" "$link"
        ok "$link → $target"
    fi
}

symlink_path "$REPO_DIR/skills"           "$CLAUDE_DIR/skills"
symlink_path "$REPO_DIR/commands"         "$CLAUDE_DIR/commands"
symlink_path "$DATA_DIR/agent/CLAUDE.md"  "$CLAUDE_DIR/CLAUDE.md"

echo ""

# ── Step 6: Register MCP server ──────────────────────────────────────────────

echo "--- Step 6: MCP server registration ---"

if [ "$HAVE_CLAUDE" = "no" ]; then
    warn "claude CLI not available — register manually:"
    warn "  claude mcp add claude-os-mcp -- node $REPO_DIR/mcp/dist/index.js"
else
    # Check if already registered (claude mcp list exits 0 and includes the name)
    if claude mcp list 2>/dev/null | grep -q "claude-os-mcp"; then
        skip "claude-os-mcp already registered"
    else
        claude mcp add claude-os-mcp -- node "$REPO_DIR/mcp/dist/index.js"
        ok "claude-os-mcp registered"
    fi
fi

echo ""

# ── Done ──────────────────────────────────────────────────────────────────────

echo "================================================"
echo " Install complete"
echo "================================================"
echo ""
ok "Restart Claude Code to pick up skills, commands, and the MCP server."
echo ""
