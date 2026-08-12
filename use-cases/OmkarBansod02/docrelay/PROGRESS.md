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
- Phase 5 — **PASS**. End-to-end workspace UI with Tailwind CSS, real API integration,
  source selection via Google Picker, edit instruction composer, explicit proposal review,
  Phase 4 dry-run visualization with safety checklist, fail-closed unsupported mapping UI,
  and no Google mutation passed.
- Phase 6 — **PASS**. Real versioned Google backup and canonical/permission verification,
  dual revision prechecks, one atomic `requiredRevisionId` write, durable conflict choices,
  UNKNOWN reconciliation without blind retry, restart/idempotency controls, complete
  structural postimage verification, minimal frontend states, and bounded real success
  and conflict proofs passed.
- Phase 7 — **PASS**. The proven single contiguous ASCII/plain-text replacement now
  supports unequal UTF-16 lengths. Baseline delete/insert coordinates remain fixed,
  the immutable expected postimage shifts all affected body indexes by the exact delta,
  and Phase 6 still requires full canonical equality after the guarded write.
- Phase 8A — **PASS**. Provider evidence established Decision C: `drive.file` is
  per-file/non-transitive and cannot provide unattended descendant discovery.
- Phase 8B — **CONDITIONAL PASS**. Explicit watch-profile OAuth, selected-root-bounded
  paginated discovery, persisted interval claims, stable-folder versioned rules,
  durable Drive-version dedupe, existing Phase 3 workflow handoff, exact-file Phase 6
  authorization gates, machine APIs, migration, and deterministic safety regressions
  passed. The bounded live `drive.readonly` consent/provider proof remains manual.

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
- The mapper accepts only one unique top-level `NORMAL_TEXT` body paragraph, one plain
  text run, and one internal contiguous ordinary ASCII text replacement; old/new UTF-16
  lengths may differ.
- A SuperDocs `chunk_id` remains review lookup evidence only; MappingProof owns the
  provider-native UTF-16 range and WritePlan owns the exact future operation intent.
- Only `WRITE_VERIFIED` is provider-write success. It requires a verified backup, an
  advanced provider revision, and exact equality with the complete baseline-derived
  canonical postimage.
- Scheduled discovery requires an explicitly upgraded connection with actual persisted
  `openid + drive.file + drive.readonly`; normal single-document OAuth remains
  `openid + drive.file` by default.
- A watched root is an application-enforced allowlist. Discovery starts only at its
  stable owned My Drive folder ID and uses parent-bounded traversal; Shared Drives and
  shared-with-me roots fail closed.
- Read-only discovery never grants write authority. A watched run requires Google
  `isAppAuthorized` proof for that exact Picker-selected file before Phase 6 can create
  a backup or write effect.

## Unresolved assumptions

- The live restricted-scope watch grant and real existing/new descendant acceptance
  proof remain pending because this environment has no configured Google OAuth client
  and consent requires a browser.
- Broader ACL/shared-drive cases and general formatting/mapping coverage remain
  unproved. Phase 6 fails closed on unknown permission forms and excludes shared drives.
- `drive.readonly` is a Google restricted scope whose token can technically read more
  than the application-selected root. Production release requires Google's applicable
  verification/security-assessment and privacy/retention controls in addition to the
  enforced traversal boundary.
- A crashed in-flight provider mutation has a 15-minute lease before UNKNOWN
  reconciliation. An UNKNOWN backup copy remains operator-attention-only because the
  proven Google contract has no safe exact-copy discovery mechanism.

## Next action

Phase 9 implementation is GO. Production release of watch mode remains gated on the
bounded live Google proof and restricted-scope compliance; do not infer Shared Drive,
new-format, broader mapping, or automatic write support from Phase 8B.

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

2026-08-10 — Phase 5 checkpoint: PASS; Tailwind CSS workspace UI with real API integration,
Google Picker source selection, edit instruction composer, explicit per-proposal review,
Phase 4 dry-run visualization with safety checklist and collapsed technical details,
fail-closed unsupported mapping UI, bounded polling, 44 frontend tests, typecheck, lint,
and production build passed; zero backend changes; no Google mutation; no commit created.

2026-08-10 — Phase 6 checkpoint: PASS; production write-back created and verified one
real same-parent Google backup before one exact revision-guarded batch update, then
verified the complete canonical postimage; a separate real concurrent edit became a
durable BEFORE_BACKUP conflict with zero DocRelay provider mutations; deterministic
safety, restart, UNKNOWN, API, and frontend tests passed; no commit created. Phase 7 GO.

2026-08-12 — Phase 8B checkpoint: CONDITIONAL PASS; production folder watch now uses an
explicit restricted read profile, selected-root-only recursive discovery, persisted
interval/fenced scan claims, stable-folder versioned rules, durable version/run dedupe,
the existing SuperDocs and human-review workflow, and exact-file write authorization
before unchanged Phase 6; deterministic backend validation passed with no automatic
Google write. Live restricted-scope consent and existing/new descendant proof remain;
Phase 9 implementation GO; no commit created.

2026-08-12 — Phase 7 checkpoint: PASS; removed the equal-UTF-16-length mapper restriction
for the existing single contiguous ASCII/plain-text subset; deterministic shorter and
longer mapping, baseline-coordinate write planning, positive/negative index deltas,
trailing-content preservation, guarded Phase 6 verification, and unrelated-difference
rejection passed. Live proof was not run because no configured Google/SuperDocs
environment was available; the bounded manual procedure remains. Phase 9 remains GO;
no commit created.
