# Bruno Collection Templates

Reference templates for bru file generation. Read this file at the start of Phase 4.

---

## collection.bru — FamilySearch Mode

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

## collection.bru — Non-FamilySearch Mode

Generate a collection.bru with Bearer auth or no auth as appropriate for the detected framework. Omit the `auth:oauth2` block; use `auth { mode: bearer }` if the API requires token auth.

---

## Environment Files — FamilySearch Mode

All four environments place non-secret values in `vars {}` and secret values in `vars:secret []`. Each variable appears in exactly one section.

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

Replace `<PORT>` and `<SERVICE_PATH>` with values from the project config (`application.yml`, `server.port`, `server.servlet.context-path`). Ask the user if not discoverable.

Add resource ID placeholder variables (e.g., `batchId:`, `requestId:`) to each environment file as discovered in Phase 3.

## Environment Files — Non-FamilySearch Mode

Generate `local.bru`, `dev.bru`, `staging.bru`, `prod.bru` with appropriate base URLs and Bearer token auth.

---

## Request File Template

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

**Rules for every request file:**
- `auth: inherit` — collection-level OAuth handles all authentication
- Path params use `:param` format (not `{param}` or `{{param}}`)
- URLs use `{{domain}}{{qualifiedPath}}/...`
- Resource IDs use captured env variables: `{{resourceId}}`
- Optional query params prefixed with `~`
- POST/PUT responses capture resource IDs in `script:post-response`
- Every request includes at least one status code test assertion
- `body:json` contains clean JSON with realistic example values from DTO analysis
- All documentation (field types, required/optional, enum values, constraints, defaults) belongs in the `docs` block
- Omit `body:json` and body docs for GET/DELETE requests that have no body
- Omit `params:query` if the endpoint has no query parameters
- Omit `script:post-response` if there is nothing to capture

---

## README.md Structure

Generate a README in the collection root with these sections:

1. **Project overview** — what service this collection covers
2. **Getting started** — prerequisites (Bruno version), how to open the collection
3. **Authentication setup** — OAuth2 PKCE flow for FS; Bearer token setup for non-FS
4. **Environment guide** — when to use each environment (Localhost / Integ / Beta / Prod)
5. **Collection structure** — visual folder tree of resources and requests
6. **Usage patterns** — common end-to-end workflows (e.g., create then get)
7. **Variables** — table of environment vars and captured runtime vars
8. **Permissions required** — list of FS permissions or scopes needed
9. **Related documentation** — links to API docs, Confluence, or Swagger
