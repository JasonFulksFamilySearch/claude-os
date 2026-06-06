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

# ── Flags ─────────────────────────────────────────────────────────────────────

PURGE_DATA=0
ASSUME_YES=0
for arg in "$@"; do
    case "$arg" in
        --purge-data) PURGE_DATA=1 ;;
        --yes|-y)     ASSUME_YES=1 ;;
        --help|-h)
            cat <<USAGE
Usage: $(basename "$0") [--purge-data] [--yes]

Removes what install.sh added to the system:
  - claude-os-mcp registration with the claude CLI
  - Symlinks at ~/.claude/skills, ~/.claude/commands, ~/.claude/CLAUDE.md
    (restores any .pre-claude-os backups found)
  - Generated config/watched-projects.json
  - Built mcp/dist and mcp/node_modules

By default, ~/.claude-data/ (agent identity + persona, learnings, project
notes, context files) is preserved — this includes agent/identity.json and
agent/personality.md (the hand-tuned per-machine soul). Pass --purge-data to
also delete it; that path requires a typed-word confirmation regardless.

The repo at $REPO_DIR is left in place. Delete it manually if desired.

Options:
  --purge-data   Also delete ~/.claude-data/ (irreversible; prompts)
  --yes, -y      Skip the top-level "uninstall?" confirmation
  --help, -h     Show this help
USAGE
            exit 0
            ;;
        *) warn "Unknown argument: $arg (ignored)" ;;
    esac
done

echo ""
echo "================================================"
echo " claude-os uninstall"
echo "================================================"
echo ""

if [ "$ASSUME_YES" != "1" ]; then
    read -rp "Uninstall claude-os from this machine? [y/N]: " confirm
    case "$confirm" in
        y|Y|yes|YES) ;;
        *) echo "Aborted."; exit 0 ;;
    esac
fi

echo ""

# ── Step 1: Unregister MCP server ─────────────────────────────────────────────

echo "--- Step 1: MCP server registration ---"

if ! command -v claude >/dev/null 2>&1; then
    warn "claude CLI not found — skipping MCP unregister; remove manually if needed."
elif ! claude mcp list 2>/dev/null | grep -q "claude-os-mcp"; then
    skip "claude-os-mcp not registered"
else
    if claude mcp remove claude-os-mcp -s user 2>/dev/null; then
        ok "claude-os-mcp unregistered (user scope)"
    else
        warn "claude mcp remove failed — remove manually with: claude mcp remove claude-os-mcp -s user"
    fi
fi

echo ""

# ── Step 2: Remove symlinks (and restore .pre-claude-os backups) ──────────────

echo "--- Step 2: Symlinks ---"

remove_symlink() {
    local link="$1"
    local expected_target="$2"

    if [ ! -L "$link" ]; then
        if [ -e "$link" ]; then
            warn "$link exists but is not a symlink — leaving alone"
        else
            skip "$link does not exist"
        fi
        return
    fi

    local current
    current=$(readlink "$link")
    if [ "$current" != "$expected_target" ]; then
        warn "$link → $current (not $expected_target) — leaving alone"
        return
    fi

    rm "$link"
    ok "Removed $link"

    if [ -e "${link}.pre-claude-os" ] || [ -L "${link}.pre-claude-os" ]; then
        mv "${link}.pre-claude-os" "$link"
        ok "Restored ${link}.pre-claude-os → $link"
    fi
}

remove_symlink "$CLAUDE_DIR/skills"     "$REPO_DIR/skills"
remove_symlink "$CLAUDE_DIR/commands"   "$REPO_DIR/commands"
remove_symlink "$CLAUDE_DIR/CLAUDE.md"  "$DATA_DIR/agent/CLAUDE.md"

echo ""

# ── Step 3: Remove generated config and build artifacts in repo ───────────────

echo "--- Step 3: Generated files in repo ---"

remove_if_exists() {
    local path="$1"
    if [ -e "$path" ]; then
        rm -rf "$path"
        ok "Removed $path"
    else
        skip "$path does not exist"
    fi
}

remove_if_exists "$REPO_DIR/config/watched-projects.json"
remove_if_exists "$REPO_DIR/mcp/dist"
remove_if_exists "$REPO_DIR/mcp/node_modules"
remove_if_exists "$REPO_DIR/mcp/package-lock.json"

echo ""

# ── Step 4: Purge ~/.claude-data (opt-in) ─────────────────────────────────────

echo "--- Step 4: User data ---"

if [ "$PURGE_DATA" != "1" ]; then
    skip "$DATA_DIR preserved (pass --purge-data to also delete it)"
elif [ ! -d "$DATA_DIR" ]; then
    skip "$DATA_DIR does not exist"
else
    echo ""
    warn "About to delete $DATA_DIR — this contains agent identity"
    warn "(identity.json + the hand-tuned personality.md), learnings.md,"
    warn "project notes, and context files. This is irreversible."
    echo ""
    read -rp "Type the literal word 'purge' to confirm: " confirm
    if [ "$confirm" = "purge" ]; then
        rm -rf "$DATA_DIR"
        ok "Removed $DATA_DIR"
    else
        skip "Confirmation not given — preserving $DATA_DIR"
    fi
fi

echo ""

# ── Done ──────────────────────────────────────────────────────────────────────

echo "================================================"
echo " Uninstall complete"
echo "================================================"
echo ""
ok "System integration points removed."
ok "The repo at $REPO_DIR is intact — delete it manually if desired."
ok "Restart Claude Code to drop the MCP connection and stop loading symlinked skills/commands."
echo ""
