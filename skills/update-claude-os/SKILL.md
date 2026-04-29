# Update Claude OS

Pull the latest changes from origin into `~/.claude-os/` and rebuild the MCP
server if needed. Use this on any machine to pick up changes pushed from another
machine (e.g., Willis syncing changes that Walter needs).

## Steps

### 1. Run the update script

```bash
~/.claude-os/update.sh
```

Stream the output so the user can see what is happening.

### 2. Report the result

After the script completes, summarize in plain language:

- If new commits were pulled: state how many commits arrived and whether the
  MCP server was rebuilt.
- If already up to date: confirm the repo was already current and nothing changed.
- If the script failed: show the error and suggest next steps (e.g., resolve a
  merge conflict manually, check network, verify git auth).
