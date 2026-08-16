# Progress

## Phase 1 — complete

Implemented the deterministic PolicySet domain core for one fictional store, Northstar Goods:

- Four managed documents: `terms`, `privacy`, `warranty`, `returns`
- Canonical `PolicyProfile` (~25 fields) covering company, store, returns, warranty, and privacy facts
- Explicit TypeScript dependency registry from managed field paths to affected documents
- `ChangeSet` with `pending` / `proposed` / `approved` / `rejected` / `failed`
- Transaction functions: create does not mutate the profile; reject and fail do not mutate the profile; commit is allowed only for an approved changeset and returns a new profile
- Deterministic HTML renderers driven only by `PolicyProfile`, each including `drafted for attorney review, not legal advice`
- Consistency validator with structured issues (missing document/disclaimer, company/contact/date mismatches, return-window and warranty-duration disagreements, stale return window after commit)

No SuperDocs calls. No editor UI.

## Phase 2 — complete

Turned the Phase 1 profile/renderers into real DOCX files and added a small server-side SuperDocs adapter.

- `generatePolicyDocuments(profile)` emits exactly four DOCX files from the same PolicyProfile
- Each file has a document title, effective date, company/contact facts, and that document's managed facts
- The attorney-review disclaimer is a real Word footer, not a body paragraph
- SuperDocs adapter covers caller-generated session ids, upload (`replace` / `background`), roster GET with `include_html`, focus, async chat with optional `document_id`, job polling, approve/deny, and focus-then-export for DOCX/PDF
- `SUPERDOCS_API_KEY` is server-side only; `.env.example` documents it
- Local preview script writes Northstar DOCX files to `tmp/policyset-preview/`; `--upload` is opt-in and does not start chat

No HITL. No synchronized ChangeSet execution. No live SuperDocs call was made during this phase.

## Phase 3 — complete

Built the user-facing intake → generate → four-document workspace flow. Frontend/product UI only.

- Guided intake on `/` with four sections (Company, Store, Returns & Warranty, Privacy), prefilled from the Northstar Goods fixture
- Generate Policy Set builds a `PolicyProfile`, runs the deterministic HTML renderers, validates the set, and opens the workspace
- Workspace shows Policy Set name, company name, consistency status, four document tabs, a document-style preview surface, and a read-only Policy Facts panel sourced from `PolicyProfile`
- Preview is explicitly a deterministic HTML surface, not SuperDocs
- Local React state only; localStorage was deferred because it complicated hydration/lint

No SuperDocs browser calls. No AI editing/HITL. No ChangeSet execution. No export.

## Phase 4 — complete

Connected the Phase 3 workspace to real, server-side SuperDocs editing with
single-document human review.

- Workspace initializes one caller-generated SuperDocs session from the current
  `PolicyProfile`, uploading Terms as `replace` and Privacy, Warranty, and Returns
  as `background`, then retains the session id and four document-id mapping in
  workspace state
- Focused Next.js route handlers cover session initialization/refresh, pinned
  edit start, async job polling, and review submission; the API key and production
  adapter remain server-only
- Every edit uses the selected tab's `document_id` with `approval_mode=ask_every_time`
  and `response_mode=full`
- Async UI covers idle, submitting, processing, awaiting review, applying,
  completed, and error states
- Review shows document, explanation, before, and after, and approves or rejects
  the full single-document batch with one explicit decision per `change_id`
- Proposal polling and review both fail closed if any pending change targets a
  document other than the selected document
- Approval polls to completion, refreshes the authoritative session roster with
  HTML, and replaces only the selected workspace document; rejection leaves the
  displayed documents and canonical profile unchanged
- Generic AI edits are explicitly language-only; no SuperDocs edit is inferred
  back into the canonical `PolicyProfile`

### Phase 4 live validation

Ran one paid edit for Northstar Goods against the Warranty document:

> Make the warranty claim instructions clearer and more concise without changing
> the warranty duration.

- Job reached `awaiting_approval` with one proposal, and its `document_id` matched
  the stored Warranty id
- The proposal rewrote the claim instruction from two sentences into one clearer,
  concise filing instruction; the explicit approval receipt covered one change
- Authoritative post-completion HTML changed for Warranty only
- The 12-month warranty value remained present
- Terms, Privacy, and Returns HTML retained identical pre/post SHA-256 hashes
- Rough edge: the first initialization attempt encountered a transient upload
  transport failure reported as `SuperDocs is unavailable`; it occurred before
  any paid chat operation, and a safe retry initialized and completed normally

## Checks run

- `npm test` — 37 passed
- `npm run typecheck` — passed
- `npm run lint` — passed
- `npm run build` — passed (Next.js 16.3.0)

## Known limitations

- Profile and changesets are in-memory functions only; there is no database or session store
- Synchronized multi-document ChangeSet execution is not implemented (Phase 5)
- The SuperDocs adapter does not implement continue prompts, session-job recovery, retries, or `open_mode=new_focused`
- Validator covers PolicySet-managed facts, not legal compliance
- Only an approved selected document is refreshed from SuperDocs HTML; the other
  workspace documents retain their current displayed content
- Intake/workspace state is not persisted across refresh
