---
name: directory-report
model: sonnet
description: Generate a comprehensive directory report for the current working directory
argument-hint: [optional: target_directory] [optional: output_filename]
---

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
# Earliest and latest file creation times
# Write file list to temp, then stat it
stat -f '%B %N' <file_paths> 2>/dev/null | sort -n | head -1
stat -f '%B %N' <file_paths> 2>/dev/null | sort -rn | head -1

# Count distinct timestamps
stat -f '%B' <file_paths> 2>/dev/null | sort -u | wc -l

# Convert epoch to readable
date -r <epoch> '+%Y-%m-%d %H:%M:%S %Z'
```

For the `stat` commands, use the file list already gathered from Glob in step 1. Write paths to `_tmp_file_list.txt` and use `xargs` to process them:

```bash
xargs stat -f '%B %N' < _tmp_file_list.txt 2>/dev/null | sort -n | head -1
```

Clean up with `rm _tmp_file_list.txt` when done.

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
