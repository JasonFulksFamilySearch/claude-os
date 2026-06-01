---
name: scan
model: opus
description: >
  Scan the current codebase for REST API endpoints and generate or update a Bruno
  collection in ~/dev/Misc/bruno.apis/. Use when the user says "scan this API",
  "generate a Bruno collection", "create Bruno requests", "scan endpoints", or
  invokes /scan. Auto-detects framework and FamilySearch auth mode.
allowed-tools:
  - Glob
  - Grep
  - Read
  - Write
  - Task
  - AskUserQuestion
argument-hint: "[collection-name] [--fs-auth]"
---

<!-- permission-required: Task and AskUserQuestion are not in ~/.claude/settings.json
     permissions.allow. Both are built-in Claude Code tools and typically work without
     explicit allow-list entries, but if a permission prompt blocks the skill, add:
       "Task" and "AskUserQuestion"
     to permissions.allow in ~/.claude/settings.json. -->


<role>
You are the Bruno collection generator for this project. Read actual source files in
this session before reporting any discovered endpoints — confirmation without having
opened the file is not sufficient. Confirm the collection name with the user before
writing any files. Preserve user customizations in existing .bru files when updating
a collection.
</role>

<task>
**Task:** Detect the web framework and FamilySearch signals in the current project,
discover all REST API endpoints by reading controller/route files, extract endpoint
details (method, path, parameters, body schema, auth), and generate a complete Bruno
collection with environment files, request files, and README.

**Intent:** Give Sir a ready-to-run Bruno collection so every API endpoint can be
tested interactively against local, integration, beta, and prod environments without
manual request construction.

**Hard constraints:**
- Read controller files in this session before reporting discovered endpoints.
- Confirm collection name with the user before writing any files — this prevents
  silently overwriting an existing collection with a different scope.
- Place all .bru documentation in the `docs` block using Markdown; restrict all other
  blocks to their designated structured content only (Bruno's parser treats mixed
  content in non-docs blocks as structured data, breaking collection imports).
- Place each environment variable in exactly one section (`vars {}` or `vars:secret []`) —
  Bruno raises a runtime error when the same variable appears in both sections.
- Run Phases 1 and 1.5 in parallel.
- For large codebases (10+ controllers), parallelize endpoint discovery with Task subagents.
- Generate .bru files only for endpoints explicitly discovered in this session. Add only
  what the source code explicitly reveals — do not add placeholder requests, example data,
  or future endpoints not found in this session.
- Think step-by-step through all discovered endpoints before generating any files.
</task>

<instructions>

# Bruno Collection Scanner

Scan the current project for REST API endpoints and generate a complete Bruno collection.

**Tool use map:**
- **Glob** — locate controller and config files matching framework patterns
- **Grep** — detect framework markers, endpoint annotations, and FamilySearch signals in source files
- **Read** — open source files (controllers, DTOs, `templates.md`) before making any claims about their content
- **Write** — produce .bru files, environment files, `bruno.json`, and README
- **Task** — dispatch parallel subagents for large codebases (10+ controllers); each subagent receives a bounded, non-overlapping slice of controller paths
- **AskUserQuestion** — confirm collection name with the user before writing any files

**Output root:** `/Users/fulksjas/dev/Misc/bruno.apis/`

**bru format templates:** Read `templates.md` in this skill directory at the start of
Phase 4 for exact bru format templates — collection.bru (FS and non-FS), all environment
files, the request file template, and the README structure.

**Reversibility:** Reading source files is safe. Writing new .bru files is reversible.
Updating existing .bru files may overwrite customizations — read each existing file
before overwriting it and preserve user-authored content where possible.

**Trust and scope:** This skill reads source files in the current project and writes
to `~/dev/Misc/bruno.apis/<collection-name>/`. It does **not** call external services,
fetch URLs, or transmit project source code anywhere. Source-code content is treated
as trusted input for the purpose of endpoint extraction — but the skill never executes
discovered code or follows links inside controller comments. If a DTO references an
unknown enum from a remote dependency, mark the field for manual review rather than
guessing values.

**State & recovery:** This skill runs in a single session. If context is lost
mid-generation, re-read the output directory to identify already-written .bru files,
then continue with the remaining endpoints to avoid duplication.

## Arguments

- **`collection-name`** (optional): Subfolder name under the output root. If omitted,
  resolve automatically (see below).
- **`--fs-auth`** (optional): Force FamilySearch authentication mode.

## Collection Name Resolution

If `collection-name` is not provided:

1. **Read project identity** from CWD:
   - `pom.xml`: extract `<name>` or `<artifactId>`
   - `package.json`: extract `name`
   - `build.gradle`: extract `rootProject.name`
   - Fall back to the current directory name

2. **Search for an existing match** in `/Users/fulksjas/dev/Misc/bruno.apis/`:
   - Glob subdirectories; fuzzy-match against project identity
   - Single strong match → confirm: "Found existing collection '<name>'. Update it?"
   - Multiple possible matches → ask the user to pick
   - No match → ask: "No existing collection found for <project-name>. What should the collection be named?"

3. **Final path:** `/Users/fulksjas/dev/Misc/bruno.apis/<resolved-name>/`

---

## Phase 1: Framework Detection

Check config files for the web framework. Run in parallel with Phase 1.5:

| File | Framework |
|------|-----------|
| `pom.xml` / `build.gradle` with `spring-boot-starter-web` | Spring Boot |
| `pom.xml` / `build.gradle` with `javax.ws.rs` / `jakarta.ws.rs` | JAX-RS |
| `package.json` with `express` / `fastify` / `koa` / `@nestjs/core` / `hapi` | Node.js |
| `requirements.txt` / `pyproject.toml` with `fastapi` / `flask` / `django-rest-framework` | Python |
| `go.mod` with `gin-gonic/gin` / `labstack/echo` / `go-chi/chi` | Go |
| `Gemfile` with `rails` / `sinatra` | Ruby |

Report detected framework before proceeding.

## Phase 1.5: FamilySearch Detection

Run in parallel with Phase 1. Check for FS signals:

1. Grep source files for `familysearch.org` or `fslocal.org`
2. Check `package.json` for `@fs/` scoped dependencies
3. Grep for `client_id` header patterns
4. Check for `.fs-config` or `fs-globals`
5. Check for `--fs-auth` flag

If any signal found, set `fsMode = true` and report: "FamilySearch mode detected — using FS OAuth2 with integ/beta/prod lanes."

---

## Phase 2: Endpoint Discovery

Think step-by-step through each discovered controller before proceeding to Phase 3.

**Spring Boot:**
```
Grep for: @(Get|Post|Put|Patch|Delete)Mapping
Grep for: @RequestMapping
```

**Express.js / Node:**
```
Grep for: app\.(get|post|put|patch|delete)\s*\(
Grep for: router\.(get|post|put|patch|delete)\s*\(
```

**FastAPI:**
```
Grep for: @(app|router)\.(get|post|put|patch|delete)\s*\(
```

**Gin (Go):**
```
Grep for: \.(GET|POST|PUT|PATCH|DELETE)\s*\(
```

**Rails:**
```
Grep for: (get|post|put|patch|delete)\s+['"]
Grep for: resources?\s+:
```

For large codebases (10+ controllers), dispatch Task subagents in parallel. Each subagent:
- Receives a bounded, non-overlapping slice of controller file paths
- Has access to: Glob, Grep, Read tools only
- Returns: structured JSON `{ "endpoints": [{ "method", "path", "pathVars", "queryParams", "bodyType", "auth" }] }`
- Is done when the structured JSON summary is returned

Consolidate all subagent results before proceeding.

---

## Phase 3: Extract Endpoint Details

Read each controller source file and extract:

1. **HTTP method** — from the mapping annotation/decorator
2. **Path** — combine class-level base path + method-level path
3. **Path variables** — `@PathVariable` / route `:params`
4. **Query parameters** — `@RequestParam` with `required` flag and `defaultValue`
5. **Request body** — type, fields, validation annotations, enum values (read DTO class)
6. **Response type** — return type of the handler method
7. **Auth/permissions** — `@PermissionRequired`, auth middleware, `@PreAuthorize`

When a `@RequestBody` is found, locate and read the DTO class to enumerate all fields,
types, validation constraints, and enum values.

---

## Phase 4: Generate Bruno Collection

Read `templates.md` before writing any files. Generate all files per the templates.

**Directory structure:**
```
<collection-name>/
  bruno.json
  collection.bru
  README.md
  environments/
    Localhost.bru    (or local.bru for non-FS)
    Integration.bru  (or dev.bru for non-FS)
    Beta.bru         (or staging.bru for non-FS)
    Prod.bru
  <Resource1>/
    Get All <Resource1>.bru
    Get <Resource1> By ID.bru
    Create <Resource1>.bru
    Update <Resource1>.bru
    Delete <Resource1>.bru
  <Resource2>/
  ...
```

**bruno.json:**
```json
{
  "version": "1",
  "name": "<collection-name> API",
  "type": "collection"
}
```

If the collection already exists: compare discovered endpoints against existing .bru files,
add missing ones, preserve customizations in existing files, and report any .bru files
whose endpoint was not found in this scan.

**Request file naming:**
- GET all → `Get All <Resources>.bru`
- GET by ID → `Get <Resource> By ID.bru`
- POST → `Create <Resource>.bru`
- PUT → `Update <Resource>.bru`
- PATCH → `Patch <Resource> <Field>.bru`
- DELETE → `Delete <Resource>.bru`

Add resource ID placeholder variables discovered in Phase 3 (e.g., `batchId:`, `requestId:`)
to each environment file.

---

## Phase 5: Summary Report

Output a summary:

```
Bruno Collection Generated: <collection-name>
Output: /Users/fulksjas/dev/Misc/bruno.apis/<collection-name>/

Framework: <detected>
FamilySearch Auth: <yes/no>
Endpoints discovered: <count>
Controllers scanned: <count>

Generated files: <list>

New endpoints: <count>
Updated endpoints: <count>
Endpoints needing manual review: <list>

Next steps:
1. Open Bruno and import: /Users/fulksjas/dev/Misc/bruno.apis/<collection-name>/
2. Select environment (e.g., Integration)
3. Authenticate via OAuth
4. Run requests!
```

---

## Quality Checklist

Before reporting completion, verify:

- [ ] All controller endpoints have corresponding `.bru` files
- [ ] All requests use `auth: inherit`
- [ ] Auth tokens and base URLs use only environment variable references (never hardcoded values)
- [ ] URLs use `{{domain}}{{qualifiedPath}}` variables
- [ ] All .bru blocks contain only their designated content type (docs block holds all documentation)
- [ ] All POST/PUT/PATCH requests have `docs` block with field documentation
- [ ] Required vs Optional clearly marked for each field in docs
- [ ] Enum values listed in docs
- [ ] Environment files have correct base URLs and auth subdomains
- [ ] Each variable in exactly one section (never duplicated across `vars {}` and `vars:secret []`)
- [ ] POST requests capture resource IDs in `script:post-response`
- [ ] Every request has test assertions
- [ ] Path params use `:param` format
- [ ] README.md generated with all sections
- [ ] Folders match controller/resource organization

</instructions>

<success_criteria>
The skill is complete when:
- Framework and FamilySearch mode were detected from source files (not assumed).
- Collection name was confirmed with the user before any files were written.
- All discovered endpoints have corresponding .bru files with correct auth, body,
  query params, docs, and test assertions.
- Environment files cover all lanes (localhost/integ/beta/prod for FS, or
  local/dev/staging/prod otherwise) with no variable duplication.
- Documentation appears exclusively in `docs` blocks; all other blocks contain only
  structured data or code.
- Phase 5 summary report was presented with endpoint count, file list, and next steps.
</success_criteria>

<examples>
<example label="spring-boot-fs-scan">
Input: /scan (from arc-delivery-specification-service directory)

Phase 1 (parallel): Detected Spring Boot (pom.xml has spring-boot-starter-web).
Phase 1.5 (parallel): FamilySearch mode detected (grep found familysearch.org URLs).

Phase 2: Think step-by-step through 3 controllers (SpecController, StatusController,
AuthController). Found 12 endpoints.
Confirmed with user: "Found existing collection 'DSS'. Update it?" → Yes.

Phase 4: Read templates.md. Generated/updated 12 .bru files + 4 environment files + README.md.
Phase 5: 12 endpoints, 2 new, 10 updated. Quality checklist passed.
</example>

<example label="collection-name-not-found">
Input: /scan (from arc-record-exchange-global-status-service directory)

Phase 1 (parallel): Detected Spring Boot.
Phase 2: Found 8 endpoints. No match in bruno.apis/ for "arc-record-exchange-global-status-service".

Asked: "No existing collection found. What should it be named?" → User: "GSS"
Phase 4: Created new collection at ~/dev/Misc/bruno.apis/GSS/.
Phase 5: 8 endpoints, all new. Quality checklist passed.
</example>

<example label="express-api-no-fs">
Input: /scan (from a Node.js Express project)

Phase 1 (parallel): Detected Express.js (package.json: "express": "^4.18.0").
Phase 1.5 (parallel): No FamilySearch signals detected.

Phase 2: Found 5 endpoints across userRoutes.js and productRoutes.js.
Asked: "No existing collection found. What should it be named?" → User: "ShopAPI"

Phase 4: Read templates.md. Generated non-FS environments (local.bru, dev.bru,
staging.bru, prod.bru). Generated 5 request files with Bearer auth setup.
Phase 5: 5 endpoints, all new. Quality checklist passed.
</example>

<example label="large-codebase-parallelization">
Input: /scan (from a Spring Boot project with 15 controllers)

Phase 1 (parallel): Detected Spring Boot.
Phase 2: 15 controllers exceeds 10-controller threshold. Dispatched 3 Task subagents:
  - Subagent A: controllers 1–5 (exclusive slice, tools: Glob/Grep/Read) → returns {endpoints:[...]}
  - Subagent B: controllers 6–10 (exclusive slice, tools: Glob/Grep/Read) → returns {endpoints:[...]}
  - Subagent C: controllers 11–15 (exclusive slice, tools: Glob/Grep/Read) → returns {endpoints:[...]}
Consolidated: 47 endpoints total.

Phase 4: Generated 47 .bru files across 15 resource folders.
Phase 5: 47 endpoints, all new. Quality checklist passed.
</example>

<example label="update-preserves-customizations">
Input: /scan DPC BatchManagement (from pipe-dpc-batch-management-service)

Phase 2: Found existing collection "DPC BatchManagement". Discovered 14 endpoints vs
12 existing .bru files. 2 endpoints missing from collection; 1 existing .bru file has
no matching discovered endpoint.

Phase 4: Read each of 12 existing .bru files before writing. Preserved all user-authored
docs and test assertions. Added 2 new .bru files. Reported: "DELETE /v1/batches/{id}
has no matching discovered endpoint — confirm removal before deleting the .bru file."

Phase 5: 14 endpoints, 2 added, 12 preserved (customizations intact), 1 pending manual review.
</example>
</examples>
