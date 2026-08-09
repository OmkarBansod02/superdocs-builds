# DocRelay

**Safe AI write-back for cloud documents.**

DocRelay is a safety-first control plane between an authoritative cloud document and
[SuperDocs](https://superdocs.app). The cloud file remains the source of truth.

The Phase 2 backend implements a Google web-application OAuth connection, read-only
inspection of explicitly authorized native Google Docs, and revision-consistent
baseline capture. It does **not** write to Google. The frontend remains the Phase 1
shell; Google Picker/UI work is intentionally separate.

The code and PostgreSQL paths are deterministically tested. Production web OAuth and
a forced refresh have been live-observed with exactly `openid + drive.file`. The
Phase 2 verdict remains conditional because a confirmed-existing manually created
test Doc returned HTTP 404 under `drive.file`; it must be explicitly app-authorized
through Picker before the read/export baseline test can complete. No broad scope or
fabricated result is used to bypass that boundary.

## Implemented boundary

```text
browser
  └─ OAuth redirect/callback (authorization code + state + PKCE)
       └─ FastAPI
            ├─ encrypted server-side OAuth credentials
            ├─ Drive files.get metadata/capabilities/parents
            ├─ Docs documents.get native structure + opaque revisionId
            ├─ Drive files.export as DOCX
            └─ PostgreSQL source and immutable baseline evidence
```

The source identity is `(Google connection/principal, provider file ID)`. Filename,
title, and path are display/location metadata only. A baseline is accepted only by
this bounded protocol:

```text
Docs documents.get → revision A
Drive files.export → DOCX bytes
Docs documents.get → revision A2
accept only when A == A2; otherwise discard the export and retry (maximum 3)
```

`revisionId` is opaque. DocRelay does not parse or sort it and does not substitute
Drive `modifiedTime`, file version, title, or path for concurrency authority.

The production Google transport exposes only `get_file`, `get_document`, and
`export_docx`; all provider requests in that transport are HTTP GETs. There is no
`files.create/update/copy`, permission mutation, or `documents.batchUpdate` code in
Phase 2.

## Requirements

- [uv](https://docs.astral.sh/uv/) 0.11 or newer
- Python 3.12–3.14
- Node.js 20.9 or newer and npm (only for the unchanged frontend shell)
- Docker with Compose for PostgreSQL 17
- A Google Cloud project only when exercising live OAuth/Google reads

## Local setup

From this directory:

```bash
docker compose up -d postgresql
cp .env.example backend/.env

cd backend
uv sync --all-groups
uv run alembic upgrade head
uv run uvicorn docrelay.main:app --reload --port 8000
```

The backend runs without Google configuration; Google status then reports
`oauth_configured: false`. Health endpoints are `GET /health/live` and
`GET /health/ready`; development OpenAPI is at `/api/docs`.

The unchanged frontend shell can still be started separately with `npm ci` and
`npm run dev` from `frontend/`.

## Google Cloud and OAuth setup

1. Create or select a Google Cloud project.
2. Enable the **Google Drive API** and **Google Docs API**. Google Picker API will be
   needed by the separately implemented frontend selection flow.
3. Configure the OAuth consent screen. For an External app in Testing, add the
   synthetic/public-safe Google account under **Test users**.
4. Create an OAuth client of type **Web application**.
5. Add this exact authorized redirect URI for local development:

   ```text
   http://localhost:8000/api/v1/google/oauth/callback
   ```

6. Generate an application encryption keyring outside source control:

   ```bash
   cd backend
   uv run python -c 'import json; from cryptography.fernet import Fernet; print(json.dumps({"v1": Fernet.generate_key().decode()}))'
   ```

7. Set these together in `backend/.env`:

   ```dotenv
   GOOGLE_OAUTH_CLIENT_ID=your-web-client-id.apps.googleusercontent.com
   GOOGLE_OAUTH_CLIENT_SECRET=your-web-client-secret
   GOOGLE_OAUTH_REDIRECT_URI=http://localhost:8000/api/v1/google/oauth/callback
   OAUTH_TOKEN_ENCRYPTION_KEYS={"v1":"your-generated-fernet-key"}
   OAUTH_TOKEN_ENCRYPTION_PRIMARY_VERSION=v1
   DOCRELAY_OWNER_SUBJECT=your-stable-application-user-subject
   ```

Start authorization by opening:

```text
http://localhost:8000/api/v1/google/oauth/authorize
```

The callback returns a safe connection response. It never returns the access token,
refresh token, client secret, stored Google principal subject, or raw credential.
The one-time callback `state` is hashed in PostgreSQL, paired with a hashed HttpOnly
browser nonce, expires after 10 minutes, and carries an encrypted PKCE verifier.
Authorization-code query parameters are redacted from the access log.

OAuth and token behavior follows Google's [web-server OAuth
flow](https://developers.google.com/identity/protocols/oauth2/web-server), [OAuth
security practices](https://developers.google.com/identity/protocols/oauth2/resources/best-practices),
and [OpenID Connect subject guidance](https://developers.google.com/identity/openid-connect/reference).
Redirect URI matching is exact. Offline access and consent are requested so Google
can issue a server-side refresh token. Refresh-token `invalid_grant` transitions the
connection to `REAUTH_REQUIRED` and removes unusable local credentials. Disconnect
revokes with Google before removing the encrypted local credential.

## Scope decision

The current scopes are exactly:

```text
openid
https://www.googleapis.com/auth/drive.file
```

- **GOOGLE DOCUMENTED:** `openid` permits retrieval of the stable, opaque Google
  `sub`. DocRelay persists that subject and deliberately does not request or persist
  email/profile data.
- **GOOGLE DOCUMENTED:** Google's current [Drive scope
  guidance](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
  recommends the non-sensitive `drive.file` scope with Google Picker for
  user-selected/app-authorized files. It avoids the restricted broad Drive scopes
  and their additional verification/security-assessment burden.
- **GOOGLE DOCUMENTED:** [Google Picker requires an access
  token](https://developers.google.com/workspace/drive/picker/guides/web-picker).
  Picker/browser token acquisition and file selection are frontend work and are not
  implemented here. The backend accepts only an opaque file ID that has already been
  authorized for this OAuth client; it does not expose a token or provide Drive-wide
  listing.
- **INFERENCE (fail-closed):** official documentation found for this phase does not
  guarantee that selecting a folder with `drive.file` grants durable access to
  **future manually added descendants**. DocRelay therefore makes no watch-mode
  claim. A staged broader scope will be considered only after the documented live
  experiment proves it necessary. Watcher/folder execution is not implemented.

Although `drive.file` technically allows changes to individually authorized files,
least privilege is also enforced at the application boundary: Phase 2 constructs no
Google mutation request.

## Credential storage

Google credentials are serialized only inside a versioned application envelope and
authenticated-encrypted with Fernet. PostgreSQL stores ciphertext, a non-secret key
version, and expiry timestamps; the encryption keys exist only in environment
configuration. Ciphertext is context-bound to the connection UUID, preventing a row
from being substituted onto another connection.

For key rotation, add a new key version, make it
`OAUTH_TOKEN_ENCRYPTION_PRIMARY_VERSION`, and retain the old key until existing rows
have been refreshed/reconnected and re-encrypted. Normal token refresh updates the
encrypted payload and supports refresh-token rotation. This is intentionally a small
application encryption boundary, not a local imitation of KMS.

## Backend API

| Method and path | Behavior |
|---|---|
| `GET /api/v1/google/connections` | Safe configuration and connection lifecycle status. |
| `GET /api/v1/google/oauth/authorize` | Persists state/PKCE evidence and redirects to Google. |
| `GET /api/v1/google/oauth/callback` | Validates state/browser binding, exchanges the code, resolves opaque `sub`, and stores encrypted credentials. |
| `POST /api/v1/google/connections/{connection_id}/disconnect` | Revokes and disconnects the connection. |
| `POST /api/v1/google/connections/{connection_id}/sources` | Validates one explicitly authorized native Google Doc ID and captures an A → DOCX → A baseline. |

Example source registration after the file has been explicitly authorized:

```bash
curl -X POST http://localhost:8000/api/v1/google/connections/CONNECTION_UUID/sources \
  -H 'Content-Type: application/json' \
  -d '{"file_id":"OPAQUE_GOOGLE_FILE_ID"}'
```

The response contains safe identity, capability, parent, revision, hash, size,
canonicalizer-version, timestamp, and attempt evidence. It excludes native document
content, DOCX bytes, and credentials. Only native Google Docs with MIME type
`application/vnd.google-apps.document` are accepted; PDFs, uploaded DOCX files,
Sheets, Slides, and arbitrary Drive types fail as `UNSUPPORTED_SOURCE_TYPE`.

Provider errors are classified into reauthorization, permission denied, file not
found, unsupported/trashed source, changed-during-capture, rate limited, unavailable,
and invalid-response outcomes. Provider bodies, authorization headers, document
bodies, and DOCX bytes are not logged.

## Tests

Deterministic checks do not require Google credentials:

```bash
cd backend
uv run pytest -m 'not live_google and not postgresql'
uv run ruff check src tests alembic
uv run ruff format --check src tests alembic
uv run mypy src
```

Run the real PostgreSQL integration test after `docker compose up -d postgresql`:

```bash
DOCRELAY_TEST_POSTGRES_URL=postgresql+asyncpg://docrelay:docrelay@localhost:5432/docrelay \
  uv run pytest -m postgresql
```

It verifies JSONB operators/types, constraints, indexes, all Phase 1 immutable
evidence triggers, the new baseline trigger, and an actually rejected update.

### Opt-in live Google test

Use only synthetic/public-safe files. Complete the backend OAuth flow first and use
the persisted connection UUID. With an explicitly app-authorized native Google Doc
and an explicitly app-authorized unsupported file, run:

```bash
DOCRELAY_RUN_LIVE_GOOGLE=1 \
DOCRELAY_LIVE_GOOGLE_CONNECTION_ID=connection-uuid \
DOCRELAY_LIVE_GOOGLE_FILE_ID=native-google-doc-id \
DOCRELAY_LIVE_GOOGLE_UNSUPPORTED_FILE_ID=unsupported-drive-file-id \
uv run pytest -m live_google
```

Add `DOCRELAY_LIVE_FORCE_REFRESH=1` to observe a real refresh through the persisted
server credential. The test accepts no copied access token and never mutates Google
content. Normal test runs skip this module.

## Canonicalization

`docrelay.google-native-canonical.v1` is a provider-specific baseline representation,
not a generic editor AST. It retains tab identity/hierarchy, structural indexes,
paragraphs/runs/styles/links/lists, tables, headers, footers, footnotes,
document/section properties, named styles/ranges, and inline/positioned objects while
removing suggestion overlays. Both raw-native and canonical SHA-256 hashes are
recorded, along with the DOCX SHA-256 and byte size. Raw provider bodies and DOCX
bytes are not persisted by the Phase 2 baseline table.

## Not implemented

- frontend Google Picker/connection UI;
- reliable watched-folder discovery or scheduling;
- SuperDocs production client, ingestion, AI editing, review, or export;
- mapping/compiler or WritePlan generation runtime;
- provider backup, Google writes, permissions changes, or `batchUpdate`;
- watcher/worker, folder-rules execution, MCP, or deployment.

These are deliberate phase boundaries. Phase 2 stops at the authoritative read path.
