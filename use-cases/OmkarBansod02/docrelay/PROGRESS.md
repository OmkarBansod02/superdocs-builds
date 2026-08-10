# DocRelay progress

Project: DocRelay  
Branch: `docrelay`

## Current checkpoint

- Gate 1 — **CONDITIONAL PASS**: the SuperDocs upload → explicit review → export
  lifecycle and restart/review recovery were proved; structural round-trip fidelity
  is not guaranteed by successful export or export warnings alone.
- Gate 2 — **CONDITIONAL PASS / DOCRELAY SCAFFOLD GO**: one uniquely mapped native
  Google Docs edit, backup, revision-guarded surgical commit, and postimage check
  were proved; the last-moment stale-write race was rejected without changing the
  human revision.
- Phase 1 — **PASS**. Live PostgreSQL migration/integration verification is complete.
- Phase 2 — **PASS** for the single-document Google source layer. Persisted OAuth,
  exact `openid + drive.file`, forced refresh, Picker-authorized native Docs reads,
  native Google Doc live source flow, DOCX export, stable baseline capture, hashing,
  and fail-closed unsupported Sheet rejection passed.
- Phase 2.5 Google Picker — **PASS**. Picker credential separation, GIS `expires_in`
  authority, invalid-expiry fail-closed handling, valid browser-token reuse in memory,
  and removal of normal-use revocation passed.
- Token lifecycle — **PASS**. GIS `expires_in` is authoritative; invalid expiry is
  fail-closed; valid browser tokens are reused in memory; and no normal-use revoke
  occurs.
- Security regression review — **PASS**.
- Phase 3 — **GO**. The folder/future-descendant experiment remains **PENDING** and
  blocks future watch mode only, not Phase 3.

## Proven assumptions

- The Google source identity is connection/principal + stable file ID; a Docs
  `revisionId` is opaque and is the concurrency authority.
- Capture accepts a DOCX export only when the surrounding native revisions match.
- SuperDocs chunk IDs are fresh-ingestion lookup evidence, not Google ranges.
- Only a uniquely proven, exact-range operation with the baseline revision may write;
  first-match/global replace and whole-document replacement are prohibited.

## Unresolved assumptions

- `drive.file` access for future manually added watched-folder descendants is not
  proved; the folder/future-descendant experiment remains **PENDING**. This blocks
  future watch mode only and does not block Phase 3.
- Broader ACL/shared-drive cases, fault-injected ambiguous external outcomes, and
  general formatting/mapping coverage remain unproved.

## Next action

Run the folder/future-descendant experiment before enabling future watch mode. It
remains pending for watch mode only; Phase 3 is cleared to proceed.

## Checkpoint log

Append concise, public-safe entries in this form:

```text
YYYY-MM-DD — checkpoint: result; verification run; remaining condition; next action.
```

2026-08-07 — scaffold checkpoint: Gates 1/2 conditionally passed and Phase 1
implementation completed; live PostgreSQL verification remains; enable Docker/PostgreSQL.

2026-08-10 — final verification: Phase 2 PASS; Phase 2.5 Google Picker PASS; Token
lifecycle PASS; Security regression review PASS; native Google Doc live source flow
and unsupported Sheet rejection passed; GIS `expires_in` is authoritative, invalid
expiry is fail-closed, valid browser tokens are reused in memory, and no normal-use
revoke occurs; Phase 3 GO. The folder/future-descendant experiment remains PENDING
for future watch mode only.

Latest verification used implementation commit `a431369` plus the current uncommitted
Picker lifecycle changes. This progress record and the private Phase 2 evidence were
updated without committing.
