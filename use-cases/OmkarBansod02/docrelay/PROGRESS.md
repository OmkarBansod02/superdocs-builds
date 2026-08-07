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
- Phase 1 — **CONDITIONAL PASS, implementation complete**. The exact remaining
  condition is live PostgreSQL migration/integration verification.
- Phase 2 — blocked at Step 0 until Docker/PostgreSQL is available.

## Proven assumptions

- The Google source identity is connection/principal + stable file ID; a Docs
  `revisionId` is opaque and is the concurrency authority.
- Capture accepts a DOCX export only when the surrounding native revisions match.
- SuperDocs chunk IDs are fresh-ingestion lookup evidence, not Google ranges.
- Only a uniquely proven, exact-range operation with the baseline revision may write;
  first-match/global replace and whole-document replacement are prohibited.

## Unresolved assumptions

- Live PostgreSQL migration and integration behavior has not yet been verified.
- `drive.file` access for future manually added watched-folder descendants is not
  proved; watch mode makes no claim yet.
- Broader ACL/shared-drive cases, fault-injected ambiguous external outcomes, and
  general formatting/mapping coverage remain unproved.

## Next action

Make Docker/PostgreSQL available, then run the documented PostgreSQL migration and
integration validation before advancing Phase 2. See `README.md` and the deeper
private records: `.private/PRD.md`, `.private/PLAN.md`,
`.private/gate1-superdocs/GATE1_REPORT.md`, `.private/gate2-google/GATE2_REPORT.md`,
and `.private/phase1/ARCHITECTURE_DECISIONS.md`.

## Checkpoint log

Append concise, public-safe entries in this form:

```text
YYYY-MM-DD — checkpoint: result; verification run; remaining condition; next action.
```

2026-08-07 — scaffold checkpoint: Gates 1/2 conditionally passed and Phase 1
implementation completed; live PostgreSQL verification remains; enable Docker/PostgreSQL.

Last verified git state: clean `docrelay` at `2224147` (`feat(docrelay): add Google
OAuth and read-only source layer`), before this guidance-file addition.
