# claude-os Sync

Commit and push all pending changes in `~/.claude-os/` to origin. Invoking
this command is the explicit signal that the current state of the repo is
intentional and ready to share.

## Steps

### 1. Status check

```bash
git status --porcelain
```

Run this inside `~/.claude-os/`. If output is empty, print:

> Nothing to sync — working tree is clean.

And stop. Do not proceed further.

### 2. Read the diff

Run both commands to understand everything that will be committed:

```bash
git diff
git diff --cached
```

Also capture the list of changed files from `git status` for the commit body.

### 3. Stage changed files

Stage each modified, added, or deleted file explicitly by name — do NOT use
`git add -A` or `git add .`. Read the `git status` output and add only the
files that appear there. The `.claude/` directory must never be staged.

### 4. Generate commit message

Read the full staged diff and write a conventional commit message:

- Format: `<Tag>: <concise description>` (≤ 50 chars)
- Valid tags: `Feat`, `Fix`, `Docs`, `Style`, `Chore`, `Refactor`, `Test`, `Perf`
- Body: prose, wrapped at 72 chars, explaining WHAT changed and WHY
- No bullet points in body
- No `Co-Authored-By` footer

The `/sync` invocation IS the approval. Do not ask for confirmation.

### 5. Commit

Use HEREDOC format:

```bash
git commit -m "$(cat <<'EOF'
<generated message>
EOF
)"
```

### 6. Push

```bash
git push
```

### 7. Report

Print a single summary line:

> Synced to origin/<branch> — N files changed.
