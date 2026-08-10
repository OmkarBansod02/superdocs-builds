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
- Phase 3 — **PASS**. The production SuperDocs adapter, durable HITL orchestration,
  explicit review lineage, restart recovery, focus-before-export, artifact hashing,
  API, worker, PostgreSQL migration, and bounded valid-credential live proof passed.
  Exactly one edit job was created; no Google write occurred.
- Phase 4 — **PASS**. Strict approved-change normalization, production mapping against
  the persisted native Google revision, immutable MappingProof/WritePlan persistence,
  exact dry-run intent, fail-closed coverage, and the bounded offline evidence proof passed.
- Phase 5 — **GO**. Phase 5 has not been started.

## Proven assumptions

- The Google source identity is connection/principal + stable file ID; a Docs
  `revisionId` is opaque and is the concurrency authority.
- Capture accepts a DOCX export only when the surrounding native revisions match.
- Repeated Google DOCX exports of the same unchanged native revision are not assumed
  to be byte-identical. A Phase 3 run freezes its newly captured package after verifying
  the provider revision and native raw/canonical hashes against the selected baseline.
- SuperDocs chunk IDs are fresh-ingestion lookup evidence, not Google ranges.
- Only a uniquely proven, exact-range operation with the baseline revision may write;
  first-match/global replace and whole-document replacement are prohibited.
- The Phase 4 V1 mapper accepts only one unique top-level `NORMAL_TEXT` body paragraph,
  one plain text run, and one internal same-UTF-16-length ASCII token replacement.
- A SuperDocs `chunk_id` remains review lookup evidence only; MappingProof owns the
  provider-native UTF-16 range and WritePlan owns the exact future operation intent.

## Unresolved assumptions

- `drive.file` access for future manually added watched-folder descendants is not
  proved; the folder/future-descendant experiment remains **PENDING**. This blocks
  future watch mode only and does not block Phase 3.
- Broader ACL/shared-drive cases, fault-injected ambiguous external outcomes, and
  general formatting/mapping coverage remain unproved.

## Next action

Begin Phase 5 only under its own scope. Phase 4 did not execute a plan, create a backup,
or call a Google mutation API. The folder/future-descendant experiment remains pending
for watch mode only.

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

2026-08-10 — Phase 3 checkpoint: CONDITIONAL PASS; deterministic backend suite,
real-PostgreSQL migration/integration, lint, formatting, and typing passed; the single
opt-in production proof was blocked before SuperDocs job creation by HTTP 401 and made
no Google write; Phase 4 NO-GO until a valid credential completes the same-job
restart/review/export proof.

2026-08-10 — Phase 3 final checkpoint: PASS; valid-credential live proof completed one
fresh upload, one edit job, awaiting review, proposal persistence, local-process
reconstruction, same session/job recovery, explicit approval, actual completion,
exact-target focus, and DOCX export containing `30 days` and no `45 days`; remote and
local job counts were both one and no Google mutation occurred. Phase 4 GO; Phase 4
implementation has not started.

2026-08-10 — Phase 4 checkpoint: PASS; approved Phase 3 evidence normalized into one
strict semantic replacement; production mapping proved one exact persisted Google body
range; immutable deterministic MappingProof and WritePlan plus machine-readable dry-run
passed fail-closed tests; the bounded offline Gate 2 evidence proof derived `[184,186)`
and exact delete/insert intent with zero provider mutation. Phase 5 GO but not started.

Latest verification uses implementation commit `34144fd` plus the current uncommitted
Phase 3 changes. No commit was created.
