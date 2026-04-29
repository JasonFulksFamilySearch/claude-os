# Generic Plan: Create/Update Bruno API Collection for REST APIs

This is a reusable template for creating or updating Bruno API collections for Spring Boot REST APIs.

---

## 🚨 MANDATORY REQUIREMENT: NO Comments in .bru Files (ONLY docs Block)

**CRITICAL: This is a NON-NEGOTIABLE, ABSOLUTE REQUIREMENT that MUST be followed for ALL Bruno request files.**

### THE RULE:
**Comments are ONLY allowed in the `docs` block. NO comments anywhere else in the .bru file.**

### What This Means:

**❌ NEVER place comments in ANY of these sections:**
- `body:json` - Clean JSON only, NO `#` comments
- `params:query` - NO `#` comments
- `meta` - NO comments
- `headers` - NO comments
- HTTP method blocks (`get`, `post`, `put`, `delete`, `patch`) - NO comments
- `script:pre-request` - NO comments (not even `//`)
- `script:post-response` - NO comments (not even `//`)
- `tests` - NO comments (not even `//`)

**✅ ONLY place documentation in:**
- `docs` block - Use Markdown format for ALL documentation

### Correct Pattern:

```bru
meta {
  name: Create Resource
  type: http
  seq: 1
}

post {
  url: {{domain}}{{qualifiedPath}}/resources
  body: json
  auth: inherit
}

params:query {
  ~level: PROJECT
  ~createSnapshot: false
}

body:json {
  {
    "requiredField": "value",
    "optionalField": "value",
    "nestedObject": {
      "field": "value"
    }
  }
}

docs {
  ## Request Body Documentation

  **Field: requiredField**
  - **Type:** String
  - **Required:** Yes
  - **Constraints:** Max length 255 characters
  - **Valid values:** VALUE_1, VALUE_2, VALUE_3
  - **Example:** "value"

  **Field: optionalField**
  - **Type:** String
  - **Required:** No
  - **Default:** null
  - **Example:** "value"

  ## Query Parameters

  **Parameter: level**
  - **Type:** String
  - **Required:** No
  - **Valid values:** FAMILY_SEARCH, RECORD_CUSTODIAN, PROJECT, REQUEST
  - **Description:** Level to retrieve specification at
}

script:post-response {
  if (res.body.id) {
    bru.setVar("resourceId", res.body.id);
  }
}

tests {
  test("Status is 201", function() {
    expect(res.status).to.equal(201);
  });
}
```

**Violation of this requirement will result in invalid .bru files and is considered a critical error.**

### ❌ WRONG Examples (Anti-Patterns)

**NEVER do this - Comments in body:json:**
```bru
body:json {
  {
    # REQUIRED: Name field    ← ❌ WRONG!
    "name": "value",

    # OPTIONAL: Description   ← ❌ WRONG!
    "description": "text"
  }
}
```

**NEVER do this - Comments in params:query:**
```bru
params:query {
  # OPTIONAL: Page number    ← ❌ WRONG!
  page: 0

  # REQUIRED: Level         ← ❌ WRONG!
  level: REQUEST
}
```

**NEVER do this - Comments in scripts:**
```bru
script:post-response {
  // Capture the resource ID    ← ❌ WRONG!
  if (res.body.id) {
    bru.setVar("resourceId", res.body.id);
  }
}
```

**✅ CORRECT - All documentation in docs block:**
```bru
docs {
  ## Request Body Documentation

  **Field: name**
  - **Required:** Yes
  - **Description:** Name field

  **Field: description**
  - **Required:** No
  - **Description:** Optional description
}

body:json {
  {
    "name": "value",
    "description": "text"
  }
}
```

---

## 📋 Preparation Checklist

Before starting, gather this information:

**Project Information:**
- [ ] Project name and description
- [ ] Service base path (e.g., `/service/records/dss`)
- [ ] Controller locations (e.g., `src/main/java/.../controller/`)
- [ ] DTO locations for request/response structures
- [ ] Existing Bruno collection path (if updating)

**API Endpoints:**
- [ ] List all controller classes
- [ ] Count total endpoints across all controllers
- [ ] Identify endpoint categories/groupings

**Authentication:**
- [ ] OAuth 2.0 configuration (authorization URL, token URL, client ID)
- [ ] Required permissions/scopes
- [ ] User-Agent header requirements

**Environments:**
- [ ] Localhost URL and port
- [ ] Integration environment URL
- [ ] Beta environment URL
- [ ] Production environment URL

---

## 🎯 Implementation Plan

### Phase 1: Collection-Level Configuration

**1.1 Create/Update `collection.bru`**

Create or update the collection configuration file:

```bru
meta {
  name: [PROJECT NAME] APIs
}

headers {
  User-Agent: fs-internal-{{username}}-bruno
  FS-User-Agent-Chain: [service-name]-bruno
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

**Key Points:**
- Use `auth: oauth2` for FamilySearch services
- Add service-specific `FS-User-Agent-Chain` header
- Enable PKCE for OAuth security

---

### Phase 2: Environment Files

**2.1 Create Standard Environments**

Create 4 standard environment files with this structure:

**`environments/Localhost.bru`:**
```bru
vars {
  domain: http://localhost:[PORT]
  qualifiedPath: [SERVICE_PATH]
  authSubdomain: integration
  authClientId: fs-internal-dev-key-000136
  username: [YOUR_USERNAME]
  [resource]Id:
  access_token:
}
```

**`environments/Integration.bru`:**
```bru
vars {
  domain: https://integration.familysearch.org
  qualifiedPath: [SERVICE_PATH]
  authSubdomain: identint
  authClientId: fs-internal-dev-key-000136
  username: [YOUR_USERNAME]
  [resource]Id:
  access_token:
}
```

**`environments/Beta.bru`:**
```bru
vars {
  domain: https://beta.familysearch.org
  qualifiedPath: [SERVICE_PATH]
  authSubdomain: identbeta
  authClientId: fs-internal-dev-key-000136
  username: [YOUR_USERNAME]
  [resource]Id:
  access_token:
}
```

**`environments/Prod.bru`:**
```bru
vars {
  domain: https://www.familysearch.org
  qualifiedPath: [SERVICE_PATH]
  authSubdomain: ident
  authClientId: fs-internal-dev-key-000136
  username: [YOUR_USERNAME]
  [resource]Id:
  access_token:
}
```

**Customization:**
- Replace `[PORT]` with localhost port (e.g., 8080, 5000)
- Replace `[SERVICE_PATH]` with qualified path (e.g., `/service/records/dss`)
- Replace `[YOUR_USERNAME]` with your FamilySearch username
- Add resource ID variables (e.g., `specificationId`, `requestId`, etc.)

---

### Phase 3: Organize by Controllers

**3.1 Map Controllers to Folders**

For each Spring Boot `@RestController` class:

1. **Create a folder** named after the controller's purpose
   - Controller: `UserController` → Folder: `Users/`
   - Controller: `ProductController` → Folder: `Products/`
   - Controller: `AdminController` → Folder: `Admin/`

2. **Group by `@RequestMapping` path**
   - `@RequestMapping("users")` → `Users/` folder
   - `@RequestMapping("admin/reports")` → `Admin/Reports/` subfolder

**Example Folder Structure:**
```
[Project] APIs/
├── collection.bru
├── README.md
├── environments/
│   ├── Localhost.bru
│   ├── Integration.bru
│   ├── Beta.bru
│   └── Prod.bru
├── [Resource1]/              # From Controller1
│   ├── Get All [Resource1].bru
│   ├── Get [Resource1] By ID.bru
│   ├── Create [Resource1].bru
│   ├── Update [Resource1].bru
│   └── Delete [Resource1].bru
├── [Resource2]/              # From Controller2
└── Admin/                    # From AdminController
    └── [Subfolder]/
```

---

### Phase 4: Create Request Files

**4.1 Request File Naming Convention**

Use descriptive, action-oriented names:
- GET all: `Get All [Resources].bru` or `Get All [Resources] (Paginated).bru`
- GET by ID: `Get [Resource] By ID.bru`
- POST: `Create [Resource].bru`
- PUT: `Update [Resource].bru`
- PATCH: `Patch [Resource] [Field].bru` (be specific about what's being patched)
- DELETE: `Delete [Resource].bru`

**4.2 Standard Request Template**

```bru
meta {
  name: [Descriptive Name]
  type: http
  seq: [1-999]
}

[get|post|put|patch|delete] {
  url: {{domain}}{{qualifiedPath}}/[endpoint-path]
  body: [none|json]
  auth: inherit
}

params:query {
  ~paramName: value
}

body:json {
  {
    "requiredField": "VALUE_1",
    "optionalField": "example-value",
    "nestedObject": {
      "nestedField": "value"
    },
    "arrayField": [
      {
        "itemField": "value"
      }
    ]
  }
}

docs {
  ## Request Body Documentation

  **Field: requiredField**
  - **Type:** String
  - **Required:** Yes
  - **Valid values:** VALUE_1, VALUE_2, VALUE_3
  - **Constraints:** Max length 255 characters
  - **Related endpoint:** Get valid values from GET /related/endpoint
  - **Example:** "VALUE_1"

  **Field: optionalField**
  - **Type:** String
  - **Required:** No
  - **Default:** null
  - **Example:** "example-value"

  **Field: nestedObject**
  - **Type:** Object
  - **Required:** Yes
  - **Description:** Nested object description

  **Field: arrayField**
  - **Type:** Array
  - **Required:** Yes
  - **Constraints:** At least 1 item required
  - **Description:** Array field description

  ## Query Parameters

  **Parameter: paramName**
  - **Type:** String
  - **Required:** No
  - **Valid values:** OPTION_1, OPTION_2
  - **Default:** OPTION_1
}

script:post-response {
  if (res.status === 201 && res.body.id) {
    bru.setVar("[resource]Id", res.body.id);
  }
}

tests {
  test("Status is [200|201|204]", function() {
    expect(res.status).to.equal([200|201|204]);
  });

  test("Response has required field", function() {
    expect(res.body.[field]).to.be.a('[string|number|array|object]');
  });
}
```

**Key Principles:**
- ✅ **Always use `auth: inherit`** - inherits from collection-level OAuth
- ✅ **Document all fields in `docs` block** - Use Markdown format, NO inline comments
- ✅ **Mark REQUIRED vs OPTIONAL** explicitly in docs
- ✅ **List valid enum values** in docs
- ✅ **Add constraints** in docs (max length, format, patterns)
- ✅ **Include examples** in docs with realistic values
- ✅ **Capture resource IDs** in post-response scripts
- ✅ **Add test assertions** for status codes and response structure
- ✅ **Comment out optional params** with `~` prefix in params:query

---

### Phase 5: Request Body Documentation Standards

**CRITICAL:** All POST, PUT, PATCH requests MUST include comprehensive documentation in the `docs` block.

**Documentation Requirements:**

1. **REQUIRED vs OPTIONAL** - Clearly mark each field
2. **Valid Values** - List all enum options or valid value ranges
3. **Constraints** - Document max lengths, formats, patterns, regex
4. **Related Endpoints** - Show where to get valid IDs or reference data
5. **Examples** - Provide contextual example values
6. **Behavior Notes** - Explain what happens when field is set
7. **Default Values** - Document what happens if field is omitted

**Template Pattern:**

**Body (clean JSON, no comments):**
```json
{
  "fieldName": "example-value",
  "optionalField": "example-value"
}
```

**Documentation (in docs block):**
```markdown
## Request Body Documentation

**Field: fieldName**
- **Type:** String
- **Required:** Yes
- **Valid values:** ENUM_1, ENUM_2, ENUM_3 OR Format: UUID, ISO 8601 date, etc.
- **Constraints:** Max length: N, Pattern: regex, etc.
- **Behavior:** Setting to X causes Y behavior
- **Related endpoint:** Get valid IDs from: GET /endpoint
- **Example:** "example-value"

**Field: optionalField**
- **Type:** String
- **Required:** No
- **Default:** null | empty array | default value
- **Example:** "example-value"
```

**Real-World Examples:**

**Enum Field:**

Body:
```json
{
  "level": "REQUEST"
}
```

Docs:
```markdown
**Field: level**
- **Type:** String (Enum)
- **Required:** Yes
- **Valid values:** FAMILY_SEARCH, RECORD_CUSTODIAN, PROJECT, REQUEST
- **Description:** Determines the scope at which specification applies
- **Example:** "REQUEST"
```

**ID Reference Field:**

Body:
```json
{
  "deliveryId": "123e4567-e89b-12d3-a456-426614174000"
}
```

Docs:
```markdown
**Field: deliveryId**
- **Type:** UUID
- **Required:** Yes
- **Format:** UUID (e.g., "123e4567-e89b-12d3-a456-426614174000")
- **Related endpoint:** Get from specification's deliveries array via GET /specifications/{id}
- **Example:** "123e4567-e89b-12d3-a456-426614174000"
```

**Constrained String Field:**

Body:
```json
{
  "name": "My Resource Name"
}
```

Docs:
```markdown
**Field: name**
- **Type:** String
- **Required:** Yes
- **Constraints:**
  - Max length: 255 characters
  - Must be unique within access unit
  - Cannot contain special characters: / \ : * ? " < > |
- **Example:** "My Resource Name"
```

**Complex Nested Structure:**

Body:
```json
{
  "path": [
    {
      "tokens": [
        {
          "type": "metadataToken",
          "field": "RequestID"
        }
      ]
    }
  ]
}
```

Docs:
```markdown
**Field: path**
- **Type:** Array of objects
- **Required:** Yes
- **Constraints:** At least 1 segment required
- **Description:** Path definition - array of path segments. Each segment defines one level of the directory structure.

**Field: path[].tokens**
- **Type:** Array of objects
- **Required:** Yes
- **Description:** Array of tokens for this path segment. Tokens are concatenated in order to form the segment name.

**Field: path[].tokens[].type**
- **Type:** String (Enum)
- **Required:** Yes
- **Valid values:** metadataToken, textToken, ordinalToken
- **Description:**
  - metadataToken = dynamic value from metadata
  - textToken = static literal text
  - ordinalToken = sequential numbering
- **Example:** "metadataToken"

**Field: path[].tokens[].field**
- **Type:** String
- **Required:** Yes (for metadataToken type)
- **Valid values:** RequestID, ProjectID, CustodianID, DGS, etc.
- **Related endpoint:** Get available fields from: GET /metadata/fields
- **Example:** "RequestID"
```

**Optional Array Field:**

Body:
```json
{
  "tags": [
    "tag1",
    "tag2"
  ]
}
```

Docs:
```markdown
**Field: tags**
- **Type:** Array of strings
- **Required:** No
- **Default:** empty array
- **Constraints:** Max 10 tags, each max 50 characters
- **Description:** Tags for categorization
- **Example:** ["tag1", "tag2"]
```

---

### Phase 6: Variable Capture and Reuse

**6.1 Capture Resource IDs**

In POST/PUT requests that create or return resources, capture the ID:

```bru
script:post-response {
  if (res.status === 201 && res.body.id) {
    bru.setVar("resourceId", res.body.id);
  }
}
```

**6.2 Use Captured Variables**

Reference captured variables in URLs:

```bru
get {
  url: {{domain}}{{qualifiedPath}}/resources/{{resourceId}}
  body: none
  auth: inherit
}
```

**6.3 Common Variable Patterns**

- Primary resource: `{resourceName}Id` (e.g., `userId`, `orderId`)
- Parent resource: `parent{ResourceName}Id`
- Related resources: `{relatedResource}Id`
- Request-scoped: `requestId`, `sessionId`

---

### Phase 7: Test Assertions

**7.1 Standard Test Patterns**

**Status Code Tests:**
```javascript
tests {
  test("Status is 200", function() {
    expect(res.status).to.equal(200);
  });
}
```

**Response Structure Tests:**
```javascript
tests {
  test("Response has ID", function() {
    expect(res.body.id).to.be.a('string');
  });

  test("Response has required fields", function() {
    expect(res.body.name).to.be.a('string');
    expect(res.body.createdDate).to.be.a('string');
  });
}
```

**Pagination Tests:**
```javascript
tests {
  test("Response has pagination", function() {
    expect(res.body.content).to.be.an('array');
    expect(res.body.totalElements).to.be.a('number');
    expect(res.body.totalPages).to.be.a('number');
  });
}
```

**Success Message Tests:**
```javascript
tests {
  test("Response has success message", function() {
    expect(res.body.message).to.include('successfully');
  });
}
```

---

### Phase 8: README Documentation

**8.1 Create Comprehensive README**

Create `README.md` in collection root with these sections:

**Required Sections:**
1. **Project Overview** - What the API does
2. **Getting Started** - Prerequisites and setup
3. **Authentication Setup** - OAuth flow instructions
4. **Environment Guide** - When to use each environment
5. **Collection Structure** - Visual folder tree
6. **Usage Patterns** - Common workflows
7. **Variables** - List of environment and captured variables
8. **Common Issues** - Troubleshooting guide
9. **Permissions Required** - List of required permissions/scopes
10. **Related Documentation** - Links to API docs, Confluence, etc.

**README Template:**
```markdown
# [PROJECT NAME] - Bruno API Collection

[Brief description of what this API does]

## Getting Started

### Prerequisites
- Bruno (install from https://www.usebruno.com/)
- [Any specific credentials or access required]

### Opening the Collection
1. Open Bruno
2. Click "Open Collection"
3. Navigate to `[COLLECTION_PATH]`
4. Select the collection

### Authentication Setup

[OAuth 2.0 or other auth setup instructions]

## Environment Guide

**Localhost:**
- For local development against `[LOCALHOST_URL]`
- Base URL: `[LOCALHOST_URL]`
- [Additional localhost notes]

**Integration:**
- Development/testing environment
- Base URL: `[INTEGRATION_URL]`
- [Additional integration notes]

**Beta:**
- Pre-production environment
- Base URL: `[BETA_URL]`
- [Additional beta notes]

**Production:**
- Live production environment
- Base URL: `[PRODUCTION_URL]`
- **Use with caution!**

## Collection Structure

[Visual tree structure of folders and requests]

## Usage Patterns

[Common workflows with step-by-step examples]

## Variables

[List of all variables and what they're for]

## Common Issues

[Troubleshooting guide for common problems]

## Permissions Required

[List of required permissions/scopes]

## Related Documentation

- [Link to API documentation]
- [Link to project README]
- [Link to Confluence pages]
```

---

## 🎨 Best Practices

### Request Organization

1. **Group by Resource** - One folder per primary resource
2. **Follow REST Conventions** - GET, POST, PUT, PATCH, DELETE
3. **Use Subfolders** - For nested or related resources
4. **Consistent Naming** - Action + Resource Name format
5. **Sequential Ordering** - Use `seq` meta field for logical ordering

### Documentation Quality

1. **Comprehensive Documentation in docs Block** - Document every field in docs block, NOT inline comments
2. **Required vs Optional** - Always explicitly mark this in docs
3. **Valid Values** - List enums and constraints in docs
4. **Examples** - Use realistic, contextual examples in docs
5. **Related Endpoints** - Show where to get reference data in docs
6. **Clean JSON** - Keep body:json sections free of ALL comments

### Authentication

1. **Use Collection-Level Auth** - Configure OAuth once at collection level
2. **Always Use `auth: inherit`** - Never configure auth per-request
3. **Remove Custom Headers** - If using OAuth, don't add manual auth headers
4. **Environment-Specific Auth** - Use `{{authSubdomain}}` for different environments

### Testing

1. **Add Assertions** - Every request should have tests
2. **Test Status Codes** - Always verify expected status
3. **Test Response Structure** - Verify key fields exist and have correct types
4. **Test Business Logic** - Verify important field values when applicable
5. **Capture Variables** - Use post-response scripts to capture IDs

### Variable Management

1. **Environment Variables** - For environment-specific values (URLs, subdomains)
2. **Captured Variables** - For resource IDs returned from API
3. **Consistent Naming** - Use `{resourceName}Id` pattern
4. **Initialize in Environments** - Add placeholder variables to environment files
5. **Document Variables** - List all variables in README

---

## 📋 Discovery Process

### Finding Endpoints from Spring Boot Code

**1. Locate Controllers:**
```bash
find [src_path] -name "*Controller.java"
```

**2. Extract Request Mappings:**
- Class-level `@RequestMapping` = base path
- Method-level `@GetMapping`, `@PostMapping`, etc. = endpoint path
- Combine: `{class-level-path}/{method-level-path}`

**3. Identify HTTP Methods:**
- `@GetMapping` = GET
- `@PostMapping` = POST
- `@PutMapping` = PUT
- `@PatchMapping` = PATCH
- `@DeleteMapping` = DELETE

**4. Find Request/Response DTOs:**
- `@RequestBody` parameter = request body structure
- Return type = response structure
- Look in `dto/` package for DTO classes

**5. Identify Path Variables:**
- `@PathVariable` = dynamic URL segments
- Use `{{variableName}}` in Bruno

**6. Identify Query Parameters:**
- `@RequestParam` = query string parameters
- Note `required=false` vs `required=true`
- Note default values

**7. Check Permissions:**
- `@PermissionRequired` = required permissions
- Document in README

---

## ✅ Quality Checklist

Before considering the collection complete, verify:

**Collection Configuration:**
- [ ] OAuth 2.0 configured with PKCE
- [ ] Collection-level headers set (User-Agent, FS-User-Agent-Chain)
- [ ] Collection name is descriptive

**Environments:**
- [ ] 4 environments configured (Localhost, Integration, Beta, Production)
- [ ] All environment variables defined
- [ ] Auth subdomains correct for each environment
- [ ] Variable placeholders added for captured values

**Requests:**
- [ ] All controller endpoints documented
- [ ] All requests use `auth: inherit`
- [ ] No hardcoded auth tokens or headers
- [ ] URLs use `{{domain}}{{qualifiedPath}}` variables
- [ ] Resource IDs use captured variables (e.g., `{{resourceId}}`)

**Request Bodies:**
- [ ] All POST/PUT/PATCH requests have comprehensive documentation in docs block
- [ ] REQUIRED vs OPTIONAL clearly marked in docs
- [ ] Valid enum values listed in docs
- [ ] Constraints documented in docs (max length, format, patterns)
- [ ] Related endpoints referenced in docs for getting reference data
- [ ] Examples use realistic, contextual values in docs
- [ ] Body JSON is clean with NO inline comments

**Variable Capture:**
- [ ] POST requests capture resource IDs in post-response scripts
- [ ] Captured variables follow naming convention
- [ ] Variables used consistently across related requests

**Tests:**
- [ ] Every request has test assertions
- [ ] Status codes verified
- [ ] Response structure validated
- [ ] Important fields checked for existence and type

**Documentation:**
- [ ] README.md created with all required sections
- [ ] Collection structure documented
- [ ] Usage patterns explained
- [ ] Variables documented
- [ ] Permissions listed
- [ ] Troubleshooting guide included

**Organization:**
- [ ] Folders match controller organization
- [ ] Request names are descriptive and consistent
- [ ] Subfolders used for nested/related resources
- [ ] Sequential ordering (`seq`) makes sense

**Testing:**
- [ ] Collection loads successfully in Bruno
- [ ] OAuth flow works in Integration environment
- [ ] At least one CRUD workflow tested end-to-end
- [ ] Variable capture and reuse works
- [ ] Environment switching works correctly

---

## 🚀 Quick Start Workflow

**For creating a NEW collection:**

1. **Preparation** (15 minutes)
   - Gather project information
   - Map controllers to endpoints
   - Identify authentication requirements

2. **Configuration** (10 minutes)
   - Create `collection.bru` with OAuth
   - Create 4 environment files

3. **Structure** (15 minutes)
   - Create folder structure matching controllers
   - Plan request organization

4. **Requests** (2-4 hours depending on API size)
   - Create request files following template
   - Add comprehensive request body documentation
   - Add test assertions
   - Add variable capture scripts

5. **Documentation** (30 minutes)
   - Create comprehensive README.md
   - Document all sections

6. **Testing** (30 minutes)
   - Load collection in Bruno
   - Test OAuth flow
   - Test at least one complete workflow
   - Verify variable capture/reuse

**For UPDATING an existing collection:**

1. **Audit** (15 minutes)
   - Compare existing collection to controller code
   - Identify missing endpoints
   - Identify outdated endpoints

2. **Configuration** (5 minutes)
   - Update collection-level settings if needed
   - Update environment files if needed

3. **Updates** (1-2 hours depending on changes)
   - Update existing requests to use `auth: inherit`
   - Add comprehensive documentation to docs blocks (remove any inline comments from JSON)
   - Add missing endpoints
   - Remove deprecated endpoints
   - Update URLs to use variables

4. **Documentation** (15 minutes)
   - Update README with new structure
   - Document new endpoints/workflows

5. **Testing** (15 minutes)
   - Verify updated requests work
   - Test new endpoints

---

## 📝 Example: Complete Request File

Here's a fully-documented example request showing all best practices:

```bru
meta {
  name: Create User
  type: http
  seq: 3
}

post {
  url: {{domain}}{{qualifiedPath}}/users
  body: json
  auth: inherit
}

body:json {
  {
    "email": "user@example.com",
    "firstName": "John",
    "lastName": "Doe",
    "role": "USER",
    "organizationId": "123e4567-e89b-12d3-a456-426614174000",
    "preferences": {
      "language": "en",
      "emailNotifications": true
    },
    "tags": [
      "engineering",
      "backend"
    ]
  }
}

docs {
  ## Request Body Documentation

  **Field: email**
  - **Type:** String
  - **Required:** Yes
  - **Format:** Valid email address (RFC 5322)
  - **Constraints:** Max length 255 characters, must be unique in the system
  - **Example:** "user@example.com"

  **Field: firstName**
  - **Type:** String
  - **Required:** Yes
  - **Constraints:** Max length 100 characters, cannot contain special characters: < > & " '
  - **Example:** "John"

  **Field: lastName**
  - **Type:** String
  - **Required:** Yes
  - **Constraints:** Max length 100 characters, cannot contain special characters: < > & " '
  - **Example:** "Doe"

  **Field: role**
  - **Type:** String (Enum)
  - **Required:** Yes
  - **Valid values:** ADMIN, USER, VIEWER
  - **Description:**
    - ADMIN = Full access to all features
    - USER = Standard access, can create/edit own resources
    - VIEWER = Read-only access
  - **Note:** Default role can be changed later via PATCH /users/{id}/role
  - **Example:** "USER"

  **Field: organizationId**
  - **Type:** UUID
  - **Required:** No
  - **Format:** UUID
  - **Related endpoint:** Get valid organization IDs from: GET /organizations
  - **Behavior:** If not provided, user is not associated with an organization
  - **Note:** Can be updated later via: PATCH /users/{id}/organization
  - **Example:** "123e4567-e89b-12d3-a456-426614174000"

  **Field: preferences**
  - **Type:** Object
  - **Required:** No
  - **Default:** empty object (system defaults used)

  **Field: preferences.language**
  - **Type:** String (Enum)
  - **Required:** No
  - **Valid values:** en, es, fr, de
  - **Default:** en
  - **Example:** "en"

  **Field: preferences.emailNotifications**
  - **Type:** Boolean
  - **Required:** No
  - **Default:** true
  - **Example:** true

  **Field: tags**
  - **Type:** Array of strings
  - **Required:** No
  - **Default:** empty array
  - **Constraints:** Max 10 tags, each max 50 characters
  - **Behavior:** Tags are case-insensitive and will be converted to lowercase
  - **Example:** ["engineering", "backend"]
}

script:post-response {
  if (res.status === 201 && res.body.id) {
    bru.setVar("userId", res.body.id);
  }
}

tests {
  test("Status is 201 Created", function() {
    expect(res.status).to.equal(201);
  });

  test("Response has user ID", function() {
    expect(res.body.id).to.be.a('string');
    expect(res.body.id).to.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  test("Response has required fields", function() {
    expect(res.body.email).to.equal('user@example.com');
    expect(res.body.firstName).to.equal('John');
    expect(res.body.lastName).to.equal('Doe');
    expect(res.body.role).to.equal('USER');
  });

  test("Response has timestamps", function() {
    expect(res.body.createdDate).to.be.a('string');
    expect(res.body.lastModifiedDate).to.be.a('string');
  });
}
```

---

## 🎯 Success Metrics

A complete Bruno collection should:

1. **✅ Cover 100% of API endpoints** - Every controller method documented
2. **✅ Use OAuth 2.0 consistently** - Collection-level auth, all requests inherit
3. **✅ Have comprehensive documentation** - Every request body field documented in docs block
4. **✅ Support all environments** - Localhost, Integration, Beta, Production
5. **✅ Enable workflow automation** - Variables captured and reused
6. **✅ Include test assertions** - Every request validates responses
7. **✅ Have clear organization** - Folders match API structure
8. **✅ Provide user guidance** - README with getting started, troubleshooting
9. **✅ Be maintainable** - Clear patterns, consistent conventions
10. **✅ Work end-to-end** - Tested with real authentication and requests

---

## 📚 Additional Resources

**Bruno Documentation:**
- Official Docs: https://www.usebruno.com/docs
- GitHub: https://github.com/usebruno/bruno

**FamilySearch Specific:**
- OAuth Setup: Internal documentation for FS OAuth configuration
- API Standards: FamilySearch API design standards
- Permission System: GRMS permission documentation

**Spring Boot References:**
- Controller Mappings: Spring @RestController documentation
- Request Validation: Jakarta Validation annotations
- DTO Patterns: Spring Boot DTO best practices

---

## 🔄 Maintenance

**When to Update the Collection:**

1. **New Endpoints Added** - Add new request files
2. **Endpoints Deprecated** - Remove or mark as deprecated
3. **Request/Response Changed** - Update DTOs and documentation
4. **Authentication Changed** - Update collection-level auth
5. **Permissions Changed** - Update README permissions section
6. **Environment URLs Changed** - Update environment files

**Quarterly Review:**
- Verify all endpoints still exist
- Test OAuth flow still works
- Update deprecated patterns
- Check for new Spring Boot best practices
- Verify README is current

---

## ⚠️ Common Pitfalls to Avoid

1. **❌ Hardcoding Auth Tokens** - Use OAuth and `auth: inherit`
2. **❌ Missing Documentation** - All request body fields must be documented in docs block
3. **❌ Inline Comments in JSON** - NEVER use `#` comments in body:json, only in docs block
4. **❌ Hardcoded Resource IDs** - Use captured variables
4. **❌ Hardcoded URLs** - Use `{{domain}}{{qualifiedPath}}`
5. **❌ No Tests** - Every request needs assertions
6. **❌ Poor Organization** - Folders should match API structure
7. **❌ Missing README** - Users need documentation
8. **❌ Incomplete Coverage** - Document ALL endpoints
9. **❌ Manual Headers** - Don't add auth headers when using OAuth
10. **❌ No Variable Capture** - POST requests should capture resource IDs

---

## 🎓 Summary

This template provides a complete, systematic approach to creating or updating Bruno API collections for REST APIs. Follow the phases in order, use the templates and best practices, and verify against the quality checklist to ensure a professional, maintainable collection.

**Key Success Factors:**
- Comprehensive request body documentation in docs block (NO inline comments)
- Clean JSON in body:json sections
- OAuth 2.0 with collection-level auth
- Variable capture and reuse for workflows
- Test assertions for every request
- Clear organization matching API structure
- Complete README with usage guide

**Time Investment:**
- New Collection: 3-6 hours depending on API size
- Update Collection: 1-3 hours depending on changes
- Well worth the investment for long-term usability and team efficiency!
