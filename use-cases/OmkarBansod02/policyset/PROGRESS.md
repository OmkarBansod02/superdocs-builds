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

## Checks run

- `npm test` — 33 passed
- `npm run typecheck` — passed
- `npm run lint` — passed
- `npm run build` — passed (Next.js 16.3.0)

## Known limitations

- Profile and changesets are in-memory functions only; there is no database or session store
- HITL review UI, SuperDocs editing, and synchronized ChangeSet execution are not implemented
- The SuperDocs adapter does not implement continue prompts, session-job recovery, retries, or `open_mode=new_focused`
- Validator covers PolicySet-managed facts, not legal compliance
- Workspace preview is deterministic HTML, not a SuperDocs editor
- Intake/workspace state is not persisted across refresh
