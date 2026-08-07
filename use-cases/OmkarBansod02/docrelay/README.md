# DocRelay

**Safe AI write-back for cloud documents.**

DocRelay is a safety-first control plane between an authoritative cloud document and
[SuperDocs](https://superdocs.app). The cloud file remains the source of truth;
SuperDocs is the document intelligence and editing engine; DocRelay will preserve the
review, mapping, backup, concurrency, write, and verification evidence required to
move an approved change between them safely.

This repository currently contains the **Phase 1 production scaffold**, not a working
cloud-sync product. It has an intentional backend/frontend boundary, PostgreSQL
persistence and migrations, immutable domain contracts, explicit state/effect
policies, provider integration seams, health checks, and deterministic tests. It does
not connect to Google or SuperDocs yet and does not edit or write any document.

Built for the SuperDocs engineering task.

## Safety architecture

```text
Next.js shell
    │
    ▼
FastAPI application / future worker
    │
    ├── pure run-state and effect policies
    ├── immutable proposal → decision → mapping → WritePlan lineage
    ├── responsibility-specific Google / SuperDocs / mapper protocols
    └── PostgreSQL evidence, audit, timing, and effect journal
```

The design locks in these invariants:

- A cloud connection plus immutable provider file ID identifies a source; names and
  paths never do.
- A run is based on one exact provider revision and a fresh SuperDocs ingestion.
- A SuperDocs chunk ID is only a lookup key inside that ingestion. It is never treated
  as a Google Docs range.
- Session-local SuperDocs document identity is always scoped by its session; durable
  SuperDocs identity is separate and non-authoritative.
- Review proposals and decisions are append-only evidence. A feedback-driven
  replacement is a new proposal in a new review round.
- A sealed WritePlan names the exact provider file, baseline revision, mapping proof,
  approved lineage, guarded provider requests, and expected provider postimage.
- The WritePlan contract rejects `targetRevisionId`, `replaceAllText`, and a revision
  guard that differs from its baseline.
- External effects distinguish `NOT_STARTED`, `STARTED`, `SUCCEEDED`, and `UNKNOWN`.
  An unknown response is not silently retried or relabeled as success.
- Unsupported mapping is a normal outcome. There is no global replacement or
  whole-document write fallback.

`PREVIEW_READY` is a durable, resumable attention state rather than a success state.
An explicit future commit may reuse the same sealed plan only after revision,
permission, dependency, and expiry checks. A conflict or expired plan creates a new
run; it does not rewrite old evidence.

## Project layout

```text
docrelay/
├── backend/
│   ├── alembic/                 PostgreSQL migration
│   ├── src/docrelay/
│   │   ├── api/                 HTTP health and request-correlation boundary
│   │   ├── core/                settings and structured logging
│   │   ├── domain/              state/effect/WritePlan policies
│   │   ├── integrations/        Google and SuperDocs protocols only
│   │   ├── mapping/             align/compile/verify protocols only
│   │   └── persistence/         SQLAlchemy models and database lifecycle
│   └── tests/
├── frontend/                    Next.js App Router shell
├── .env.example                 safe configuration placeholders
└── docker-compose.yml           PostgreSQL development dependency
```

## Requirements

- [uv](https://docs.astral.sh/uv/) 0.11 or newer
- Python 3.12–3.14 (uv will select a compatible interpreter)
- Node.js 20.9 or newer and npm
- Docker with Compose for the local PostgreSQL service

No Google or SuperDocs credential is needed for the Phase 1 tests or frontend build.

## Local setup

From this directory:

```bash
docker compose up -d postgresql
cp .env.example backend/.env
cp .env.example frontend/.env.local

cd backend
uv sync --all-groups
uv run alembic upgrade head
uv run uvicorn docrelay.main:app --reload --port 8000
```

In a second terminal:

```bash
cd frontend
npm ci
npm run dev
```

Open `http://localhost:3000`. The shell performs a real backend readiness check. The
API exposes:

- `GET /health/live` — process liveness; deliberately has no database dependency.
- `GET /health/ready` — returns 200 only when required PostgreSQL access succeeds,
  otherwise 503.
- `/api/docs` — development-only OpenAPI UI.

The default Compose credentials are local-development values only. Change them for
any non-local environment.

## Configuration

The checked-in `.env.example` contains placeholders only.

| Variable | Phase 1 behavior |
|---|---|
| `DATABASE_URL` | Required by the backend. Non-test runtimes require `postgresql+asyncpg://`. |
| `APP_ENV` | `development`, `test`, or `production`. Production disables API docs. |
| `LOG_LEVEL` | Structured JSON log level. Request bodies and credentials are not logged. |
| `CORS_ORIGINS` | JSON array of allowed frontend origins. |
| `SUPERDOCS_API_KEY` | Optional placeholder; no live SuperDocs client exists yet. |
| `GOOGLE_OAUTH_CLIENT_ID` | Optional placeholder; OAuth is not implemented. |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Optional typed secret placeholder. |
| `GOOGLE_OAUTH_REDIRECT_URI` | Reserved callback location for a later OAuth phase. |
| `OAUTH_TOKEN_ENCRYPTION_KEY` | Reserved for future versioned envelope encryption. No refresh tokens are stored in Phase 1. |
| `NEXT_PUBLIC_DOCRELAY_API_URL` | Backend origin used by the browser health check. It must never contain a secret. |

Do not add `GOOGLE_ACCESS_TOKEN`, OAuth access/refresh tokens, or real credentials to
source files. Provider tokens will eventually require server-side encryption at rest,
key versioning/rotation, redaction, and ownership checks before OAuth can ship.

## Development checks

Backend:

```bash
cd backend
uv run pytest
uv run ruff check src tests alembic
uv run ruff format --check src tests alembic
uv run mypy src
DATABASE_URL=postgresql+asyncpg://docrelay:docrelay@localhost:5432/docrelay \
  APP_ENV=development uv run alembic upgrade head --sql
```

With PostgreSQL running, apply the migration with:

```bash
cd backend
uv run alembic upgrade head
uv run alembic current
```

Frontend:

```bash
cd frontend
npm ci
npm run lint
npm run typecheck
npm run build
```

The deterministic backend suite covers allowed and illegal state transitions,
preview resumability, WritePlan freezing/integrity and forbidden write shapes,
effect uncertainty/reconciliation, configuration validation, health/readiness, and
persistence of provider/SuperDocs/review/replacement/plan/effect identity. Its
persistence fixture uses SQLite only as a fast cross-dialect ORM test; PostgreSQL is
the production database and the migration emits JSONB plus immutable-evidence
triggers.

## Intended SuperDocs integration

Later phases will implement the already-bounded REST lifecycle:

```text
DOCX upload into a fresh session
→ resolve explicit session-local + durable document identity
→ async edit targeted by document ID with ask_every_time
→ recover/poll repeated review rounds and explicit decisions
→ completion
→ focus the exact target
→ export DOCX and retain warning evidence
```

DocRelay will keep its own proposal and decision ledger rather than treating a vendor
summary as the applied-change record. Provider write-back will use a separately
proved mapping and a guarded native Google Docs batch; exported DOCX bytes will never
be uploaded over the source.

## Initial supported write scope

No write scope is implemented in Phase 1. The first live implementation remains
deliberately limited to one native Google Doc, one root tab, an ordinary body
paragraph, one exact plain internal ASCII token replacement of equal UTF-16 length,
one uniquely proved baseline association, an explicit approved proposal, a verified
independent backup, one atomic `batchUpdate(requiredRevisionId=A)`, and an exact
canonical provider reread. Everything else remains unsupported until separately
proved.

## Not implemented

- live Google OAuth, Drive discovery, Docs reads/exports, permissions, or watching;
- a SuperDocs HTTP client, ingestion, AI editing, review submission, or export;
- mapping/compiler/canonical-verifier algorithms;
- review, conflict, backup, or verification product UI;
- provider backup creation or guarded write-back;
- scheduler, production worker, retries, or effect reconciliation runtime;
- folder scheduling/rule management behavior (only future persistence shapes exist);
- multi-document editing, MCP, deployment, or fake/demo providers and data.

These are deliberate phase boundaries, not completed features.
