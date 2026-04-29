---
name: scan
description: Scan codebase for REST API endpoints and generate/update a Bruno collection in ~/dev/Misc/bruno.apis/
allowed-tools:
  - Glob
  - Grep
  - Read
  - Write
  - Bash
  - Agent
  - AskUserQuestion
argument-hint: "[collection-name] [--fs-auth]"
---

# Bruno Collection Scanner

Scan the current project's codebase for REST API endpoints and generate a complete Bruno collection.

**Output root (hardcoded):** `/Users/fulksjas/dev/Misc/bruno.apis/`

## Arguments

- **`collection-name`** (optional): Subfolder name under the output root (e.g., `"DPC BatchManagement"`, `"GSS"`, `"REOS"`). If omitted, the skill auto-detects it (see below).
- **`--fs-auth`** (optional): Force FamilySearch authentication mode (OAuth2 + PKCE, integ/beta/prod lanes)

## Collection Name Resolution

If `collection-name` is not provided as an argument, resolve it automatically:

1. **Read the project identity** from CWD:
   - `pom.xml`: extract `<name>` or `<artifactId>` (e.g., `pipe-dpc-batch-management-service`)
   - `package.json`: extract `name`
   - `build.gradle`: extract `rootProject.name`
   - Fall back to the current directory name

2. **Search for an existing match** in `/Users/fulksjas/dev/Misc/bruno.apis/`:
   - List all subdirectories in the bruno.apis root
   - Fuzzy-match the project identity against existing collection names (e.g., `pipe-dpc-batch-management-service` matches `DPC BatchManagement`)
   - If a single strong match is found, confirm with the user: "Found existing collection 'DPC BatchManagement'. Update it?"
   - If multiple possible matches, ask the user to pick
   - If no match, ask the user: "No existing collection found for <project-name>. What should the collection be named?"

3. **Final output path:** `/Users/fulksjas/dev/Misc/bruno.apis/<resolved-collection-name>/`

---

## MANDATORY: NO Comments in .bru Files

**Comments are ONLY allowed in the `docs` block. NO comments anywhere else in any .bru file.**

Prohibited:
- `body:json` — clean JSON only, NO `#` comments
- `params:query` — NO `#` comments
- `meta`, `headers`, HTTP method blocks — NO comments
- `script:pre-request`, `script:post-response`, `tests` — NO comments (not even `//`)

All documentation goes in the `docs` block using Markdown format.

---

## Phase 1: Framework Detection

Detect the web framework by checking config files in the current project. Run checks in parallel:

| File | Framework |
|------|-----------|
| `pom.xml` or `build.gradle` with `spring-boot-starter-web` | Spring Boot |
| `pom.xml` or `build.gradle` with `javax.ws.rs` / `jakarta.ws.rs` | JAX-RS |
| `package.json` with `express` / `fastify` / `koa` / `@nestjs/core` / `hapi` | Node.js |
| `requirements.txt` or `pyproject.toml` with `fastapi` / `flask` / `django-rest-framework` | Python |
| `go.mod` with `gin-gonic/gin` / `labstack/echo` / `go-chi/chi` | Go |
| `Gemfile` with `rails` / `sinatra` | Ruby |

Report detected framework before proceeding.

## Phase 1.5: FamilySearch Detection

Run in parallel with framework detection. Check for FS signals:

1. Grep source files for `familysearch.org` or `fslocal.org` URL patterns
2. Check `package.json` for `@fs/` scoped dependencies
3. Grep for `client_id` header patterns in source code
4. Look for FS config files (`.fs-config`, `fs-globals`)
5. Check if `--fs-auth` flag was passed

If any signal found, set `fsMode = true` and report: "FamilySearch mode detected -- using FS OAuth2 with integ/beta/prod lanes."

---

## Phase 2: Endpoint Discovery

Based on detected framework, search for route definitions:

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

For large codebases (10+ controllers), use Agent subagents to parallelize discovery across controller groups.

---

## Phase 3: Extract Endpoint Details

For each discovered endpoint, read the source file and extract:

1. **HTTP method** — from the mapping annotation/decorator
2. **Path** — combine class-level `@RequestMapping` base path + method-level path
3. **Path variables** — `@PathVariable` / route `:params`
4. **Query parameters** — `@RequestParam` with `required` flag and `defaultValue`
5. **Request body** — `@RequestBody` type; read the DTO class to enumerate fields, types, validation annotations (`@NotNull`, `@Size`, `@Pattern`, enum values)
6. **Response type** — return type of the handler method
7. **Auth/permissions** — `@PermissionRequired`, auth middleware, `@PreAuthorize`

### Spring Boot DTO Analysis

When a `@RequestBody` parameter is found:
1. Locate the DTO class (check `dto/`, `model/`, `domain/` packages)
2. Read all fields — note type, nullability, validation annotations
3. For enums: read the enum class to get all values
4. Map these to the `docs` block documentation format

---

## Phase 4: Generate Bruno Collection

**Output directory:** `/Users/fulksjas/dev/Misc/bruno.apis/<collection-name>/`

If the collection already exists, compare existing requests against discovered endpoints. Add missing endpoints, report any that may have been removed. Preserve user customizations in existing `.bru` files where possible.

### 4.1 Directory Structure

```
<collection-name>/
  bruno.json
  collection.bru
  README.md
  environments/
    Localhost.bru
    Integration.bru
    Beta.bru
    Prod.bru
  <Resource1>/          # One folder per controller/resource
    Get All <Resource1>.bru
    Get <Resource1> By ID.bru
    Create <Resource1>.bru
    Update <Resource1>.bru
    Delete <Resource1>.bru
  <Resource2>/
  ...
```

### 4.2 bruno.json

```json
{
  "version": "1",
  "name": "<collection-name> API",
  "type": "collection"
}
```

### 4.3 collection.bru

**If fsMode is active:**

```bru
meta {
  name: <COLLECTION_NAME> APIs
}

headers {
  User-Agent: fs-internal-{{username}}-bruno
  FS-User-Agent-Chain: <service-name>-bruno
}

auth {
  mode: oauth2
}

auth:oauth2 {
  grant_type: authorization_code
  callback_url: https://localhost:8999/
  authorization_url: https://{{authSubdomain}}.familysearch.org/service/ident/cis/cis-web/oauth2/v3/authorization
  access_token_url: https://{{authSubdomain}}.familysearch.org/service/ident/cis/cis-web/oauth2/v3/token
  refresh_token_url:
  client_id: fs-internal-dev-key-000136
  client_secret:
  scope:
  state:
  pkce: true
  credentials_placement: body
  credentials_id: credentials
  token_placement: header
  token_header_prefix: Bearer
  auto_fetch_token: true
  auto_refresh_token: false
}
```

**Otherwise:** Generate a simpler collection.bru with Bearer auth or no auth as appropriate.

### 4.4 Environment Files

**CRITICAL: Each variable in exactly ONE section.** `accessToken` always in `vars:secret`. Never duplicate a variable across `vars {}` and `vars:secret []`.

**If fsMode is active**, generate 4 environments:

**Localhost.bru:**
```bru
vars {
  domain: http://localhost:<PORT>
  qualifiedPath: <SERVICE_PATH>
  authSubdomain: integration
  authClientId: fs-internal-dev-key-000136
  username: fulksjas
}

vars:secret [
  access_token
]
```

**Integration.bru:**
```bru
vars {
  domain: https://integration.familysearch.org
  qualifiedPath: <SERVICE_PATH>
  authSubdomain: identint
  authClientId: fs-internal-dev-key-000136
  username: fulksjas
}

vars:secret [
  access_token
]
```

**Beta.bru:**
```bru
vars {
  domain: https://beta.familysearch.org
  qualifiedPath: <SERVICE_PATH>
  authSubdomain: identbeta
  authClientId: fs-internal-dev-key-000136
  username: fulksjas
}

vars:secret [
  access_token
]
```

**Prod.bru:**
```bru
vars {
  domain: https://www.familysearch.org
  qualifiedPath: <SERVICE_PATH>
  authSubdomain: ident
  authClientId: fs-internal-dev-key-000136
  username: fulksjas
}

vars:secret [
  access_token
]
```

Replace `<PORT>` and `<SERVICE_PATH>` with values discovered from the project config (e.g., `application.yml`, `server.port`, `server.servlet.context-path`). Ask the user if not discoverable.

Add resource ID placeholder variables to each environment as needed (e.g., `batchId:`, `requestId:`).

**Otherwise (non-FS):** Generate `local.bru`, `dev.bru`, `staging.bru`, `prod.bru` with appropriate URLs.

### 4.5 Request Files

**Naming convention:**
- GET all: `Get All <Resources>.bru`
- GET by ID: `Get <Resource> By ID.bru`
- POST: `Create <Resource>.bru`
- PUT: `Update <Resource>.bru`
- PATCH: `Patch <Resource> <Field>.bru`
- DELETE: `Delete <Resource>.bru`

**Request file template:**

```bru
meta {
  name: <Descriptive Name>
  type: http
  seq: <order>
}

<method> {
  url: {{domain}}{{qualifiedPath}}/<endpoint-path>
  body: <none|json>
  auth: inherit
}

params:query {
  ~optionalParam: defaultValue
}

body:json {
  {
    "field": "value"
  }
}

docs {
  ## Endpoint Description

  <Brief description of what this endpoint does>

  ## Request Body Documentation

  **Field: fieldName**
  - **Type:** String
  - **Required:** Yes
  - **Valid values:** VALUE_1, VALUE_2, VALUE_3
  - **Constraints:** Max length 255
  - **Example:** "VALUE_1"

  **Field: optionalField**
  - **Type:** String
  - **Required:** No
  - **Default:** null
  - **Example:** "value"

  ## Query Parameters

  **Parameter: paramName**
  - **Type:** String
  - **Required:** No
  - **Valid values:** OPTION_1, OPTION_2
  - **Default:** OPTION_1
}

script:post-response {
  if (res.status === 201 && res.body.id) {
    bru.setVar("resourceId", res.body.id);
  }
}

tests {
  test("Status is 200", function() {
    expect(res.status).to.equal(200);
  });
}
```

**Key rules for every request file:**
- Always `auth: inherit` (collection-level OAuth handles auth)
- Path params use `:param` format (NOT `{param}` or `{{param}}`)
- URLs use `{{domain}}{{qualifiedPath}}/...`
- Resource IDs use captured variables: `{{resourceId}}`
- Optional query params prefixed with `~`
- POST/PUT responses capture resource IDs in `script:post-response`
- Every request has `tests` with at minimum a status code assertion
- `body:json` contains clean JSON with realistic example values from DTO analysis
- `docs` block contains ALL documentation: field types, required/optional, enum values, constraints, defaults, related endpoints, examples
- Omit `body:json` and body-related docs for GET/DELETE requests that have no body
- Omit `params:query` if no query parameters
- Omit `script:post-response` if nothing to capture

### 4.6 README.md

Generate a README in the collection root with:
1. Project overview
2. Getting started (prerequisites, opening in Bruno)
3. Authentication setup (OAuth flow for FS)
4. Environment guide (when to use each)
5. Collection structure (visual folder tree)
6. Usage patterns (common workflows)
7. Variables (environment + captured)
8. Permissions required
9. Related documentation links

---

## Phase 5: Summary Report

Output a summary to the user:

```
Bruno Collection Generated: <collection-name>
Output: /Users/fulksjas/dev/Misc/bruno.apis/<collection-name>/

Framework: <detected framework>
FamilySearch Auth: <yes/no>
Endpoints discovered: <count>
Controllers scanned: <count>

Generated files:
  <list of generated/updated files>

New endpoints: <count>
Updated endpoints: <count> (if updating existing collection)
Endpoints needing manual review: <list, if any>

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
- [ ] No hardcoded auth tokens or URLs
- [ ] URLs use `{{domain}}{{qualifiedPath}}` variables
- [ ] NO comments in any `.bru` file except `docs` blocks
- [ ] All POST/PUT/PATCH requests have `docs` block with field documentation
- [ ] Required vs Optional clearly marked for each field in docs
- [ ] Enum values listed in docs
- [ ] Environment files have correct base URLs and auth subdomains
- [ ] Each variable in exactly ONE section (never in both `vars {}` and `vars:secret []`)
- [ ] POST requests capture resource IDs in `script:post-response`
- [ ] Every request has test assertions
- [ ] Path params use `:param` format
- [ ] README.md generated with all sections
- [ ] Folders match controller/resource organization
