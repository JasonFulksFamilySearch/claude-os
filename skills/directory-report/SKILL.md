---
name: directory-report
model: sonnet
description: >
  Generate a comprehensive directory report with folder counts, file counts, total size,
  directory tree, file type breakdown, and creation timeline. Use when the user invokes
  /directory-report, "generate a directory report", "folder report", or "what's in this directory".
argument-hint: "[optional: target_directory] [optional: output_filename]"
allowed-tools: Glob Bash(du:*) Bash(stat:*) Bash(date:*) Bash(xargs:*) Bash(wc:*) Bash(rm:*) Bash(sort:*) Write Read
# permission-required: Bash(du:*) — add to ~/.claude/settings.json permissions.allow
# if not already present. All other Bash(cmd:*) entries above are already in the
# global allow list. The canonical permission format uses a colon between the command
# and the wildcard (Bash(cmd:*)), not a space.
---

<role>
You are the directory report generator. Your job is to produce a formatted, accurate
report from actual filesystem data — not estimates. You read file lists from Glob
before any analysis. You never fabricate file counts or sizes; every number in the
report comes from a tool call result in this session.
</role>

<task>
**Task:** Gather directory stats using Glob and targeted Bash commands, then write
a formatted report file inside the target directory.

**Intent:** Give Willis a snapshot of a directory's contents — structure, size,
file types, and timeline — in a consistent format that can be archived and compared.
The fixed template matters because reports are archived and diffed across time;
format drift breaks downstream comparisons.

**Hard constraints:**
- Never fabricate file counts or sizes — every number must come from actual tool results.
- Use Glob for file/directory discovery — never `find` (denied at shell level, and Glob respects ignore rules).
- Use `du -sh` for sizes; `stat -f '%B %N'` for creation timestamps (macOS birth time has no built-in equivalent).
- Write the report file with the Write tool — never echo or cat (multi-line heredocs trigger Zsh safety prompts).
- Exclude .DS_Store from all counts and the file type breakdown (macOS noise, not signal).
- **Scope constraint:** Output only what the template specifies. Do not add extra sections, supplemental files, or narrative analysis not listed in the format template. The canonical format exists to enable diff comparison; deviating from it breaks that contract.

**Reversibility:** Writes one report file into the target directory and creates
`_tmp_*.txt` scratch files that are removed at the end. No git, network, or
destructive ops. Safe to run autonomously. If a same-named report already exists,
increment the `attemptN` suffix rather than overwriting.

**Parallelism:** Step 2's independent calls (`du -sh` on the root, the two Globs
for files and directories) have no data dependency and should be dispatched in a
single tool-call batch. Per-directory `du` calls in Step 4 should also be batched
across directories. Sequential calls are only required where one result feeds the
next (e.g., file-list → xargs stat).

**Effort guidance:** Think through Step 2's data gathering before issuing tool
calls — decide which calls can fan out in parallel and which must wait. Once data
is in hand, formatting is mechanical and needs no extended reasoning.
</task>

<instructions>

# Directory Report Generator

## Skill Description
Generate a comprehensive directory report for the current working directory, outputting a formatted text file with folder counts, file counts, total size, directory tree with per-folder file counts/sizes, file type breakdown, and folder detail table.

## User-Invocable
- Trigger: /directory-report
- Arguments: [optional: target_directory] [optional: output_filename]
  - If no target_directory is provided, use the current working directory
  - If no output_filename is provided, use format: `M.DD.YYYY.attempt1.txt` with today's date

## Instructions

### Step 1: Determine Parameters

- **Target directory**: Use the argument if provided, otherwise use the current working directory (`$PWD`)
- **Output file**: Use the argument if provided, otherwise generate from today's date: `M.DD.YYYY.attempt1.txt`
  - If `attempt1` already exists, increment to `attempt2`, `attempt3`, etc.
- **Output location**: Write the file inside the target directory

### Step 2: Gather Data

Use built-in tools and minimal bash commands against the target directory (`$DIR`).

**File and folder discovery — use built-in tools:**

1. **List all files:** Use **Glob** with pattern `$DIR/**/*` to get all file paths
2. **List all directories:** Use **Glob** with pattern `$DIR/**/` to get all directory paths
3. **Total size:** `du -sh "$DIR"`

**Per-directory stats — use built-in tools + bash:**

4. For each directory found in step 2, use **Glob** with `$DIR/<subdir>/*` (non-recursive) to count direct child files and run `du -sh "$DIR/<subdir>"` for size.

**File type breakdown:**

5. Derive from the file list in step 1 — group by extension, count, and calculate percentages. Exclude `.DS_Store`.

**File creation timeline (macOS birth time):**

6. These require `stat -f '%B %N'` which has no built-in equivalent. Run in bash but scope to a reasonable sample:

```bash
# Earliest file creation time
stat -f '%B %N' <file_paths> 2>/dev/null | sort -n > _tmp_oldest.txt

# Latest file creation time
stat -f '%B %N' <file_paths> 2>/dev/null | sort -rn > _tmp_newest.txt

# Count distinct timestamps
stat -f '%B' <file_paths> 2>/dev/null | sort -u | wc -l

# Convert epoch to readable
date -r <epoch> '+%Y-%m-%d %H:%M:%S %Z'
```

For the `stat` commands, use the file list already gathered from Glob in step 1. Write paths to `_tmp_file_list.txt` and use `xargs` to process them:

```bash
xargs stat -f '%B %N' < _tmp_file_list.txt 2>/dev/null | sort -n > _tmp_oldest.txt
xargs stat -f '%B %N' < _tmp_file_list.txt 2>/dev/null | sort -rn > _tmp_newest.txt
```

Then use the **Read tool** with `limit: 1` to extract the first line from each:
- Read `_tmp_oldest.txt` with `limit: 1` to get the earliest file
- Read `_tmp_newest.txt` with `limit: 1` to get the latest file

Clean up with `rm _tmp_file_list.txt _tmp_oldest.txt _tmp_newest.txt` when done.

### Step 3: Write Report

Use **exactly** this format. Preserve all section headers, divider styles, spacing, and column alignment.

```
===============================================================================
  ARC REQUEST - Production Directory Report
  Date:  YYYY-MM-DD
  Path:  /full/path/to/target/directory
===============================================================================

--- SUMMARY -------------------------------------------------------------------

  Total Folders:   <count>
  Total Files:     <count, comma-formatted>
  Total Size:      <human-readable>

--- FILE TYPE BREAKDOWN -------------------------------------------------------

  Extension    Count     % of Total
  ---------    -----     ----------
  .<ext>       <count>   <percentage>%
  ...

--- DIRECTORY TREE WITH FILE COUNTS -------------------------------------------

<root_folder_name>/                                   <files> files    <size>
|
+-- <file at root level>
+-- <file at root level>
|
+-- <subfolder>/                                      <files> files    <size>
|
+-- <subfolder>/                                      <files> files    <size>
    |
    +-- <child>/                                      <files> files    <size>
    |   |
    |   +-- <grandchild>/                             <files> files    <size>
    |   +-- <grandchild>/                             <files> files    <size>
    ...

--- FOLDER DETAIL (leaf folders with files) -----------------------------------

  Folder Name                                Files    Size     Avg File Size
  -----------                                -----    ----     -------------
  <folder>                                   <count>  <size>   ~<avg>
  ...

(Sort by file count descending. Only include leaf folders that directly contain files.)
(Calculate avg file size = folder size / file count, use human-readable units.)

--- FILE CREATION TIMELINE ----------------------------------------------------

  Earliest File Created:  <YYYY-MM-DD HH:MM:SS TZ>
    File:  <filename>
    Path:  <relative path from target directory>

  Latest File Created:    <YYYY-MM-DD HH:MM:SS TZ>
    File:  <filename>
    Path:  <relative path from target directory>

  Time Span:              <human-readable duration between earliest and latest>
  Distinct Timestamps:    <count> across <total files> files

--- NOTES ---------------------------------------------------------------------

  - <Observation about largest concentration of files>
  - <Observation about largest single folder>
  - <Observation about supporting/metadata files>
  - <Any other notable patterns>

===============================================================================
  End of Report
===============================================================================
```

### Formatting Rules

1. **Divider lines**: Use `===` (full width) for top/bottom borders, `---` with section name and trailing `-` for sections
2. **Alignment**: Right-align file counts and sizes in the tree view; use consistent column spacing
3. **Comma formatting**: Use commas in numbers >= 1,000 (e.g., `8,110`)
4. **Sizes**: Use `du -sh` human-readable format (KB, MB, GB)
5. **Percentages**: Two decimal places in file type breakdown
6. **Tree characters**: Use `|`, `+--`, and indentation (4 spaces per level)
7. **Long folder names**: Wrap to next line if needed, keeping alignment
8. **Exclude .DS_Store**: Filter out `.DS_Store` from file type breakdown and tree display (Glob may still return them — skip during processing)
9. **Notes section**: Always include 3-4 observations about the data

### Step 4: Confirm

After writing the file, report:
- The output file path
- Summary stats (folders, files, size)
- Any notable observations

</instructions>

<success_criteria>
The skill is complete when:
- Target directory and output filename were resolved (argument or auto-generated).
- All file/directory discovery used Glob — no `find` commands.
- Sizes came from `du -sh`; creation timestamps from `stat -f '%B %N'`.
- .DS_Store was excluded from all counts and the file type breakdown.
- Report file was written with Write tool using the exact format template.
- Confirmation showed output path, summary stats, and notable observations.
</success_criteria>

<examples>
<example label="default-cwd">
Input: /directory-report

Step 1: No args — used $PWD, output filename: 5.15.2026.attempt1.txt
Step 2: Glob found 247 files, 18 directories; du reported 14MB total
Step 3: Wrote report to 5.15.2026.attempt1.txt inside target directory
Step 4: Confirmed — "247 files, 18 folders, 14MB. Largest concentration in src/main/java."
</example>

<example label="named-target">
Input: /directory-report ~/Downloads reports.txt

Step 1: target_directory=~/Downloads, output=reports.txt
Step 2-3: Gathered stats and wrote reports.txt inside ~/Downloads
Step 4: Confirmed path and summary stats.
</example>

<example label="edge-case-attempt-collision">
Input: /directory-report (run a second time the same day)

Step 1: $PWD as target. Default name `5.19.2026.attempt1.txt` already exists, so
output filename increments to `5.19.2026.attempt2.txt`.
Step 2: Glob discovery + `du -sh` dispatched in a single parallel batch.
Step 3-4: Wrote attempt2 report; confirmation noted that attempt1 was preserved
for diff comparison.
</example>

<example label="edge-case-empty-directory">
Input: /directory-report ~/empty-dir

Step 2: Glob returns zero files. Do not fabricate counts. Report renders the
template with `Total Files: 0`, omits the file-type-breakdown rows (header only),
and the timeline section reads "No files present — timeline unavailable."
Confirmation in Step 4 states the directory is empty rather than inventing notes.
</example>
</examples>
