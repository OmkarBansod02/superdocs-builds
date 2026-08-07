# DocRelay agent guide

Work only within `use-cases/OmkarBansod02/docrelay/`. Keep changes small, reviewable,
and tied to the current phase; do not create a demo path that bypasses production
safety contracts.

## Authority and safety

When sources disagree, follow this order: assigned SuperDocs build requirements;
current SuperDocs documentation; official cloud-provider documentation; then the
product PRD, implementation plan, and locked architecture decisions. Record a
material contradiction before coding rather than silently choosing an assumption.

- The cloud document, identified by provider principal + stable file ID + revision,
  is authoritative. Names and paths are metadata only.
- Every source read, approval, backup, write, and verification must be durable,
  attributable evidence. A new authoritative revision needs a new run and fresh
  SuperDocs ingestion.
- Never silently write a stale source. Re-check the baseline, use the provider's
  conditional write primitive, and treat ambiguous external outcomes as recoverable
  `UNKNOWN`, not success or an automatic retry.
- Compile only uniquely proven, surgical operations. Never select a first repeated
  match, use global replace, or fall back to replacing an entire file/document.
- Unsupported, ambiguous, unverified, unauthorized, or stale work must fail closed;
  do not broaden scope or weaken a guard to make a run succeed.

## Working method

1. Read this file, `PROGRESS.md`, and the relevant public code/tests. Consult the
   deeper private decision/report files only as needed; their evidence is not public.
2. Confirm the applicable contract and phase boundary before implementation.
3. For hard safety behavior (staleness, immutable lineage, mapping uniqueness,
   guarded writes, recovery), write or update a failing deterministic test first.
4. Implement the smallest typed change. Persist checkpoints/effect intent before an
   external call, so a restart can reconcile rather than guess.
5. Run focused tests, then the supported validation suite. Ask a fresh reviewer to
   independently check high-risk safety invariants or a phase/gate conclusion when
   useful.
6. Update `PROGRESS.md` only with public-safe checkpoint facts and the next action.

## Data, logs, and repository hygiene

- Keep raw research, live evidence, fixtures, and reports under `.private/`; never
  commit that directory or copy its payloads/identifiers into public files.
- Never commit secrets. Do not log credentials, tokens, authorization-code values,
  raw provider/SuperDocs payloads, document bodies, or exported document bytes.
  Redact sensitive query parameters and use synthetic/public-safe data for live work.
- Do not use broad mechanical/global replacements or whole-file fallback edits.
  Make localized changes and preserve unrelated worktree changes.

## Current phases and validation

The currently implemented boundary is read-only Google OAuth/source baseline capture;
write-back, watcher execution, and product UI remain later work. See
`.private/PRD.md`, `.private/PLAN.md`, the gate reports, and
`.private/phase1/ARCHITECTURE_DECISIONS.md` for rationale and phase detail.

Supported checks (from `backend/` unless noted):

```bash
uv run pytest -m 'not live_google and not postgresql'
uv run ruff check src tests alembic
uv run ruff format --check src tests alembic
uv run mypy src
```

With Docker PostgreSQL running, also run:

```bash
DOCRELAY_TEST_POSTGRES_URL=postgresql+asyncpg://docrelay:docrelay@localhost:5432/docrelay \
  uv run pytest -m postgresql
```

Use the opt-in live Google test only with configured credentials and synthetic or
public-safe files; follow `README.md` for its exact environment and command.
