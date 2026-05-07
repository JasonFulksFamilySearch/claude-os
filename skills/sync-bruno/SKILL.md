---
name: sync-bruno
description: Use when Bruno API collection files in ~/dev/Misc/bruno.apis need to be synced with their Spring Boot source repos — new endpoints added, changed DTOs updated, deleted endpoints removed. Invoke as /sync-bruno or /sync-bruno "Collection Name".
---

# sync-bruno

Full diff-and-sync between a Spring Boot service's source code and its Bruno API collection. Detects new, changed, and deleted endpoints, then auto-applies all changes.

## Invocation

- `/sync-bruno` — sync all collections in `.claude/collections-map.json`
- `/sync-bruno "Collection Name"` — sync one named collection

---

## Phase 1 — Setup

1. Read `/Users/fulksjas/dev/Misc/bruno.apis/.claude/collections-map.json`
2. Determine target collections from args (all vs named)
3. Verify each `repoPath` exists on disk; skip with warning if missing

---

## Phase 2 — Source Analysis

Dispatch a **parallel Explore subagent per collection**. The subagent must:

**Step A — Check for Enunciate swagger.json:**
Check if `{repoPath}/{swaggerPath}` exists. If found, note its age relative to the controller source files (stale = older than most `.java` files).

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

Match manifest endpoints to inventory by `method + normalizedPath`:

| Result | Condition |
|---|---|
| **CREATE** | Endpoint in manifest, no matching `.bru` file |
| **UPDATE** | Endpoint in both manifest and inventory |
| **DELETE** | `.bru` file in inventory, no matching endpoint in manifest |

> On first sync, most files will show as UPDATE — this is correct. The skill regenerates them with fresh docs from source, which is the intent.

---

## Phase 5 — Apply Changes

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

If swagger.json was stale or missing, append:
```
⚠ swagger.json not found or stale. Run `mvn enunciate:enunciate` in {repoPath}/webapp for a fresher source.
  Fell back to Java source analysis.
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
