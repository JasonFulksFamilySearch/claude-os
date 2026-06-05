---
name: sync-bruno
description: >
  Diff and sync Bruno API collection files against their Spring Boot source repos —
  add new endpoints, update changed DTOs, remove deleted endpoints. Use when the user
  invokes /sync-bruno, "sync bruno", "update bruno collection", "sync api collection",
  or "my endpoints changed and bruno is out of date".
argument-hint: '[optional: "Collection Name"]'
allowed-tools: Read Glob Grep Write Bash(rm *) Agent
---

<role>
You are the Bruno collection sync agent. Your job is to keep Bruno request files
accurate by diffing against actual source code — not by guessing what changed. You
read the swagger.json or controller files before asserting what endpoints exist.
You never assert endpoints without reading the source in this session. You confirm
the collection name before writing any files.
</role>

<task>
**Task:** Read the collections-map.json config, discover all current endpoints from
source (swagger or Java), inventory existing .bru files, compute the diff, and apply
CREATE/UPDATE/DELETE changes to bring the collection in sync.

**Intent:** Give the user accurate Bruno request files after any backend change without
manual endpoint hunting — one command, full sync.

**Hard constraints:**
- Never assert endpoints without reading the source files (swagger or Java) in this session — asserted endpoints that don't exist create dead requests; missed endpoints leave the collection incomplete.
- Confirm the collection name before writing any files — writing to the wrong collection is a multi-file corruption that requires a git revert to undo.
- Never put comments in .bru files except in the `docs` block — comments outside the docs block cause Bruno parse errors that silently break the request.
- Dispatch parallel Explore subagents per collection in Phase 2 and Phase 3 — serial processing is prohibitively slow for multi-collection syncs.
- Follow the bruno-collection-creation-template.md exactly for file structure — deviating from the template breaks Bruno's parser or `{{variable}}` resolution.
- Generate only fields and content that exist in the actual source — do not invent request body fields, query parameters, or response documentation not found in swagger or Java source.
- Trust and scope: write and delete only inside `{collectionPath}` directories listed in `collections-map.json`. Never touch files outside `/Users/fulksjas/dev/Misc/bruno.apis/`. Source repos under `repoPath` are read-only for this skill.
- Reversibility: `Write` overwrites are recoverable from git (collections live in a git repo). `rm` deletes are reversible only via git checkout — confirm the file is tracked before issuing `rm`; if untracked, surface it to Sir before deleting.
</task>

<instructions>

# sync-bruno

Full diff-and-sync between a Spring Boot service's source code and its Bruno API collection. Detects new, changed, and deleted endpoints, then auto-applies all changes.

## Invocation

- `/sync-bruno` — sync all collections in `.claude/collections-map.json`
- `/sync-bruno "Collection Name"` — sync one named collection

---

## Phase 1 — Setup
**Tools: Read**

1. Read `/Users/fulksjas/dev/Misc/bruno.apis/.claude/collections-map.json`
2. Determine target collections from args (all vs named)
3. Verify each `repoPath` exists on disk; skip with warning if missing

---

## Phase 2 — Source Analysis
**Tools (dispatched to Explore subagent): Glob, Read, Grep**

Dispatch a **parallel Explore subagent per collection**. The subagent must:

**Step A — Check for Enunciate swagger.json:**
Check if `{repoPath}/{swaggerPath}` exists. If found, note its age relative to the controller source files (stale = older than most `.java` files).

If swagger.json is **missing**, also check whether `{repoPath}/webapp/target/classes` exists:
- **Present** → compiled classes on disk; `mvn enunciate:enunciate` alone (~30s, no recompile needed) would regenerate swagger.json. Set `swaggerAge: "missing-compiled"`.
- **Absent** → no build output at all; a full build is required first. Set `swaggerAge: "missing-no-classes"`.

**Step B — If swagger.json exists:** Parse all `paths` entries. For each path+method, extract:
- HTTP method and URL path
- Path parameters (name, type)
- Query parameters (name, type, required, enum values, default)
- Request body schema fields (for POST/PUT/PATCH) with types, required flag, enum values, constraints
- Response body shape (top-level fields and types)

**Step C — If swagger.json missing or cannot be parsed:** Read all `*Controller.java` files under `controllersPath` and all `.java` DTO/model files under `modelsPath`. Use AI analysis to extract the same fields from `@GetMapping`/`@PostMapping`/etc., `@RequestParam`, `@PathVariable`, `@RequestBody`, and return types. Also look for `@PermissionRequired` annotations.

**Return a normalized endpoint manifest:**
```json
{
  "source": "swagger | java",
  "swaggerAge": "2 days | stale | n/a",
  "endpoints": [
    {
      "method": "GET",
      "path": "/specifications/{specificationId}",
      "folder": "Specifications",
      "suggestedName": "Get Specification By ID",
      "seq": 2,
      "pathParams": [
        { "name": "specificationId", "type": "UUID", "required": true }
      ],
      "queryParams": [
        { "name": "level", "type": "String", "required": false, "enum": ["FAMILY_SEARCH","RECORD_CUSTODIAN","PROJECT","REQUEST"], "default": null }
      ],
      "requestBody": null,
      "responseShape": { "id": "UUID", "name": "String", "deliveries": "Array" },
      "successStatus": 200,
      "permissions": []
    }
  ]
}
```

**Folder inference:** Use the first URL segment after `qualifiedPath`, title-cased. `/specifications/{id}` → `Specifications/`. Nested paths (e.g. `/admin/maintenance/validate`) → `Admin/Maintenance/`.

**Suggested name conventions:**
- GET by ID: `Get {Resource} By ID`
- GET list/paginated: `Get All {Resources}` or `Get All {Resources} (Paginated)`
- POST: `Create {Resource}`
- PUT: `Update {Resource}`
- PATCH: `Patch {Resource} {Field}` (be specific)
- DELETE: `Delete {Resource}`
- Admin/utility: Use the method's purpose (e.g., `Validate Naming Schemas`)

---

## Phase 3 — Inventory Existing .bru Files
**Tools (dispatched to Explore subagent): Glob, Read**

Dispatch an **Explore subagent per collection** to inventory current request files:
- List all `.bru` files recursively under `{collectionPath}/`
- Exclude: `collection.bru`, anything under `environments/`
- For each file, read: `meta.name`, HTTP method block method + URL

Return an inventory map:
```json
{
  "Specifications/Get Specification By ID.bru": {
    "method": "GET",
    "url": "{{domain}}{{qualifiedPath}}/specifications/{{specificationId}}",
    "normalizedPath": "/specifications/{specificationId}"
  }
}
```

**URL normalization for matching:** Replace `{{variableName}}` → `{variableName}`. This bridges Bruno's `{{paramVar}}` syntax and Spring Boot's `{pathVariable}` syntax.

---

## Phase 4 — Diff Computation
**Tools: none (computation only)**

> **State integrity:** The manifest from Phase 2 and the inventory from Phase 3 must both be in active context when entering Phase 4. For large collections, if context budget is approaching limits, write both structures to `_tmp_sync_manifest.json` and `_tmp_sync_inventory.json` before proceeding — clean up both files after Phase 6 completes.

Before matching, verify that URL normalization was applied consistently to both manifest paths and inventory paths — a mismatch (e.g., `{specificationId}` vs `{{specificationId}}`) silently generates a spurious CREATE+DELETE pair instead of an UPDATE. Check for trailing-slash aliases and path prefix variations before classifying any endpoint as CREATE.

Match manifest endpoints to inventory by `method + normalizedPath`:

| Result | Condition |
|---|---|
| **CREATE** | Endpoint in manifest, no matching `.bru` file |
| **UPDATE** | Endpoint in both manifest and inventory |
| **DELETE** | `.bru` file in inventory, no matching endpoint in manifest |

> On first sync, most files will show as UPDATE — this is correct. The skill regenerates them with fresh docs from source, which is the intent.

---

## Phase 5 — Apply Changes
**Tools: Write (CREATE/UPDATE), Bash `rm` (DELETE). Before deleting, run `git ls-files --error-unmatch '{absoluteCollectionPath}/{relativePath}'` to confirm the file is tracked.**

### CREATE and UPDATE: Generate .bru files

Follow `/Users/fulksjas/dev/Misc/bruno.apis/.claude/bruno-collection-creation-template.md` exactly. The generated file structure:

```
meta {
  name: {suggestedName}
  type: http
  seq: {seq}
}

{method} {
  url: {{domain}}{{qualifiedPath}}/{path with {{paramVar}} for path params}
  body: {none|json}
  auth: inherit
}

params:query {
  {~paramName: exampleValue}
}

body:json {
  {
    "field": "exampleValue"
  }
}

docs {
  ## {Description or endpoint purpose}

  {## Request Body Documentation — only if POST/PUT/PATCH}
  **Field: fieldName**
  - **Type:** {type}
  - **Required:** Yes|No
  - **Valid values:** {enum list if applicable}
  - **Constraints:** {max length, format, pattern if known}
  - **Default:** {default value if optional}
  - **Example:** "{realistic example}"

  {## Query Parameters — only if query params exist}
  **Parameter: paramName**
  - **Type:** {type}
  - **Required:** Yes|No
  - **Valid values:** {enum list if applicable}
  - **Default:** {default}
}

script:post-response {
  if (res.status === {successStatus} && res.body.id) {
    bru.setVar("{resourceName}Id", res.body.id);
  }
}

tests {
  test("Status is {successStatus}", function() {
    expect(res.status).to.equal({successStatus});
  });
  {additional assertions based on responseShape}
}
```

**Non-negotiable rules (violations cause Bruno parse errors):**
- `#` comments are NEVER allowed in `body:json`, `params:query`, `headers`, `script:*`, or `tests` blocks
- ALL documentation belongs in the `docs` block only
- Always `auth: inherit` — never configure auth per-request
- URL format must be `{{domain}}{{qualifiedPath}}/path/{{paramVar}}`
- Optional query params must be prefixed with `~`
- `script:post-response` only on POST/PUT that return a resource with an `id` field
- Omit blocks that don't apply (no empty `params:query {}`, no `body:json` on GET)

Write each file with the Write tool. Create parent subdirectories as needed.

### DELETE: Remove stale files

```bash
rm "{absoluteCollectionPath}/{relativePath}"
```

---

## Phase 6 — Summary
**Tools: none**

Print after all changes are applied:

```
sync-bruno: {Collection Name}
Source: swagger.json ({age}) | java source
─────────────────────────────────────────
✓ Created (N):
  + Folder/Request Name.bru

✓ Updated (N):
  ~ Folder/Request Name.bru

✓ Deleted (N):
  - Folder/Request Name.bru

No changes: N files
```

If swagger.json was stale or missing, append the appropriate message:

**Missing, classes compiled** (`swaggerAge: "missing-compiled"`):
```
⚠ swagger.json not found — but compiled classes exist. A fast enunciate-only build would sharpen
  constraint and enum documentation without a full recompile:
    cd {repoPath}/webapp && mvn enunciate:enunciate   (~30s)
  Fell back to Java source analysis.
```

**Missing, no classes** (`swaggerAge: "missing-no-classes"`):
```
⚠ swagger.json not found and no compiled classes found. Run a full build first:
    cd {repoPath}/webapp && mvn package -DskipTests && mvn enunciate:enunciate
  Fell back to Java source analysis.
```

**Stale** (`swaggerAge: "stale"`):
```
⚠ swagger.json is stale (older than controller source). Re-run to get fresher constraint docs:
    cd {repoPath}/webapp && mvn enunciate:enunciate
  Used stale swagger.json — endpoint shape is likely correct; constraints/enums may lag.
```

---

## Config Reference

Mapping config lives at: `/Users/fulksjas/dev/Misc/bruno.apis/.claude/collections-map.json`

| Field | Purpose |
|---|---|
| `name` | Display name and match key for `/sync-bruno "name"` arg |
| `collectionPath` | Relative path to collection folder from `bruno.apis/` root |
| `repoPath` | Absolute path to Spring Boot service repo |
| `swaggerPath` | Relative path from `repoPath` to Enunciate swagger.json |
| `controllersPath` | Relative path from `repoPath` to controller source |
| `modelsPath` | Relative path from `repoPath` to DTO/model source |
| `qualifiedPath` | Service base path used in Bruno URL variables |
| `localhostPort` | Port for the Localhost environment |

</instructions>

<success_criteria>
The skill is complete when:
- collections-map.json was read to determine target collections.
- Endpoints were discovered from actual source (swagger.json or Java controllers) — not assumed.
- Existing .bru files were inventoried via parallel Explore subagents.
- Diff was computed: CREATE, UPDATE, DELETE for each endpoint.
- All changes applied — new .bru files written, stale files deleted.
- No comments appear in any .bru file except docs blocks.
- Phase 6 summary printed with counts for created, updated, deleted, unchanged.
</success_criteria>

<examples>
<example label="single-collection-sync">
Input: /sync-bruno "DPC BatchManagement"

Phase 1: Read collections-map.json — found DPC BatchManagement entry.
Phase 2 (parallel subagent): Found swagger.json, parsed 8 endpoints.
Phase 3 (parallel subagent): Inventoried 6 existing .bru files.
Phase 4 Diff: CREATE 2 (new endpoints), UPDATE 5 (DTO changes), DELETE 1 (removed endpoint).
Phase 5: Applied all changes.
Phase 6: Summary — Created: 2, Updated: 5, Deleted: 1, No change: 0.
</example>

<example label="delete-heavy-cleanup">
Input: /sync-bruno "DPC SpecManagement"

Phase 2 (parallel subagent): swagger.json fresh, 4 endpoints parsed.
Phase 3 (parallel subagent): Inventoried 11 existing .bru files — most are stale leftovers from a removed controller.
Phase 4 Diff: CREATE 0, UPDATE 4, DELETE 7.
Phase 5: Confirmed all 7 .bru files are tracked in git, issued `rm` for each; updated 4 in place.
Phase 6: Summary — Created: 0, Updated: 4, Deleted: 7.
</example>

<example label="collection-name-not-found">
Input: /sync-bruno "Nonexistent Collection"

Phase 1: Read collections-map.json — no entry matches "Nonexistent Collection".
Reported: "No collection named 'Nonexistent Collection' in collections-map.json. Available collections: [list]. Re-invoke with a correct name or run /sync-bruno with no args to sync all."
Stopped before Phase 2 — no source analysis or writes attempted.
</example>

<example label="swagger-stale-fallback">
Input: /sync-bruno

Phase 2: swagger.json found but older than most .java files — swaggerAge: "stale". Used it anyway.
Phase 6 footer: "⚠ swagger.json is stale. Re-run enunciate to freshen constraint docs."
</example>

<example label="swagger-missing-compiled">
Input: /sync-bruno "REOS"

Phase 2: swagger.json not found. webapp/target/classes exists — swaggerAge: "missing-compiled".
Fell back to Java source analysis.
Phase 6 footer: "⚠ swagger.json not found — compiled classes exist. Run mvn enunciate:enunciate (~30s)."
</example>
</examples>
