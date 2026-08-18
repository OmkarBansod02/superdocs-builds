# SuperDocs issues observed during PolicySet development

This document records SuperDocs behavior PolicySet observed during live testing
that looked like a rough edge or a possible bug in the SuperDocs API, separate
from PolicySet's own application logic. It is written conservatively: nothing
here is claimed as a confirmed, reproducible SuperDocs defect unless the
evidence for that specific claim is unambiguous from a single artifact. Where
confidence is lower, that is stated explicitly.

The three issues below were observed while building PolicySet's synchronized
managed-fact ChangeSet feature: a single logical edit (the return window
changing from 30 days to 14 days) that must land, correctly and completely, in
two managed documents (Terms of Service and Returns Policy) or not commit at
all.

## Common reproduction setup

1. Create one SuperDocs session (caller-generated session id).
2. Upload four documents to the session: one as `open_mode=replace` (focused),
   the other three as `open_mode=background`.
3. Record the `document_id` SuperDocs assigns to each upload.
4. Send a chat edit instruction naming two of the four documents by title,
   asking for the same managed fact (a numeric "return window") to change in
   both, and explicitly protecting the other two documents, unrelated content,
   and headers/footers.
5. Poll the job (`GET`/job-status endpoint) until `awaiting_approval`.
6. Inspect `pending_changes` before submitting any review decision: for each
   proposal, compare `document_id`, `chunk_id`, `old_html`, and `new_html`.
7. After a review decision, retrieve the authoritative document roster
   (`include_html=true`) to see final content.

Every run below used PolicySet's own fail-closed safety gates, which denied
every pending change before any approval was submitted. No proposal from
either issue was ever approved. The canonical PolicyProfile never left its
starting value in any of these runs.

---

## Issue 1: Multi-document edit can nondeterministically omit an explicitly named document

**Classification:** `SUPERDOCS_ROUGH_EDGE` / possible bug
**Confidence:** Low-to-moderate — do not treat as a confirmed bug yet.

### What we did

Sent one chat edit request (no `document_id`, i.e. an unpinned, message-routed
request) against a session containing four documents, naming two of them by
title in the instruction text and asking for the same numeric fact to change
in both.

### Expected behavior

An unpinned chat request that names two documents by title, in a session
where both documents are present (one focused, one background), produces
proposals against both named documents.

### Actual behavior

Across two separate live runs of an equivalent instruction shape:

- **Run A:** Proposals were returned against **both** named documents, but
  each document's batch was only a partial edit — some required occurrences
  of the managed fact were updated, others were left stale. (This is
  effectively a completeness gap, not a full document omission — see the
  "Impact" note below.)
- **Run B (final run):** Proposals were returned against only **one** of the
  two named documents. The second named document received **zero** proposals,
  even though it was uploaded to the same session and named explicitly, by
  title, in the instruction text.

These two runs are inconsistent with each other under what otherwise looked
like the same instruction shape and session setup. That reads as
nondeterministic scope handling for unpinned multi-document requests, not a
fixed, documented limitation.

We could not find documentation stating what message-based (unpinned) routing
does when a message names multiple documents by title — the reference
material we had only documents that an explicit `document_id` "takes
precedence over message-based routing and current focus." Because of that, we
cannot describe this as a violation of a documented contract, only as
surprising and inconsistent observed behavior.

### Impact on PolicySet

PolicySet's synchronized-edit feature requires that a managed fact change
land in every affected document, completely, or not commit at all. An
unpinned request that can silently narrow its own scope to fewer documents
than requested defeats that guarantee for any fact affecting more than one
document — which is most managed facts in PolicySet's dependency model.

### Workaround

Do not rely on unpinned, multi-document chat requests for changes that must
span more than one document. Issue one explicit, `document_id`-pinned chat
request per affected document instead, and gate approval on every pinned
request's batch independently passing safety and completeness checks before
approving any of them. PolicySet's production code was changed to do exactly
this (see `PROGRESS.md`, Phase 5 reliability fallback).

---

## Issue 2: An edit proposal batch contained proposals with byte-identical `old_html`/`new_html`, including against protected header/footer chunks

**Classification:** `POSSIBLE_SUPERDOCS_BUG`, recommended to report to SuperDocs
**Confidence:** The no-op-content finding itself is unambiguous from a single
artifact (`old_html === new_html` for an operation typed `"edit"` is not
something that requires reproduction to establish). Whether it reproduces on
a second job is unknown — only one job exhibited this.

### What we did

Same setup as above. Inspected every proposal in one job's `pending_changes`
batch before submitting any review decision, comparing each proposal's
`old_html` and `new_html` byte-for-byte.

### Expected behavior

A proposal with `operation: "edit"` represents an actual content change:
`old_html` and `new_html` should differ.

### Actual behavior

Of 26 total proposals in one job's batch:

- 2 proposals contained a real, correct content change (the managed fact
  moving from its old value to its new value).
- **24 of 26 proposals had byte-identical `old_html` and `new_html`** — every
  one of them a no-op "edit" — most carrying an AI-generated explanation
  claiming a change had been made, even where nothing in that chunk's text
  matched the value the instruction asked to change.
- **2 of those 24 no-op proposals targeted the document's header and footer
  chunks** (identifiable by structural markers on the containing element),
  which the instruction had explicitly asked not to be modified. The content
  was unchanged in both cases, but SuperDocs still emitted an `"edit"`
  operation against protected structural parts.

### Impact on PolicySet

A reviewer (human or automated) looking at this batch would see 13x more
proposed changes than were actually real, and two of the padding proposals
targeted content PolicySet explicitly protects. This makes a raw proposal
batch unsafe to auto-approve and required PolicySet to build its own
application-side filtering: a completeness/coverage check that ignores
proposals which don't touch a required occurrence, and a structural-safety
check that rejects any proposal — real or no-op — targeting an identified
header/footer chunk.

### Evidence

A sanitized, redacted snapshot of the full proposal batch for this job is
preserved locally (git-ignored, not included in this repository) at the path
documented in `PROGRESS.md`. It was captured automatically before any review
decision was submitted, contains only proposal-shaped fields plus a local
structural classification, has secret-shaped values redacted, and was written
with restrictive file permissions.

### Workaround

PolicySet's proposal gate rejects any batch that contains a proposal
targeting a chunk holding no required occurrence of the fact being changed
(this also naturally rejects no-op proposals against unrelated content, since
a no-op cannot ever satisfy a required occurrence), and separately rejects
any proposal — real or no-op — that structurally targets a header or footer.
Both checks fire before any approval is submitted, and the whole batch is
denied if either check fails.

### Recommendation

We recommend SuperDocs verify reproducibility of no-op `"edit"` proposals
against protected structural parts on their end before treating this as
understood; this report reflects a single observed job.

---

## Issue 3: Pinned single-document edit can report completion while leaving an explicitly named managed occurrence unchanged

**Classification:** `SUPERDOCS_ROUGH_EDGE` / possible bug
**Confidence:** Moderate-to-high in the *observed behavior* — the incomplete
batch and the contradicting completion message are both unambiguous from a
single artifact. Deliberately **not** claimed as a confirmed API bug: this
plausibly sits in model/edit-generation behavior rather than in an API
contract, and no documented contract promises exhaustive occurrence coverage.

### What we did

Sent one chat edit request against a session, this time with `document_id`
explicitly pinned to a single document (Terms of Service) — no unpinned
routing, no second document in scope. The instruction named the managed fact
change (a numeric "return window", 30 days to 14 days) and explicitly
required:

- update **every** occurrence
- update the `Return window (days)` summary fact line
- update the body policy prose, quoting both phrasings verbatim
  (`within 30 days of delivery` and `30-day window`)
- leave no 30-day return-window occurrence anywhere in the document
- do not modify unrelated numeric values
- do not modify headers or footers

### Expected behavior

Before the batch could be approved, the document should contain no stale
managed 30-day return-window occurrence — every occurrence named in the
instruction receives a proposal.

### Actual behavior

The job reached `awaiting_approval` and returned **exactly one** proposal.
That proposal was correct as far as it went: it updated the body prose, moving
both `within 30 days of delivery` and `30-day window` to their 14-day forms in
a single chunk edit.

The explicitly named summary fact line — `Return window (days): 30` — received
**no proposal at all** and remained at 30.

Separately, the response carried a completion-style message asserting that the
return window had been updated from 30 days to 14 days in the document. That
claim contradicts the batch actually produced, which left one named occurrence
stale.

### Why it matters

Two independent problems compose here. The edit is partial, and the
provider-side signal that would tell a caller it was partial says the opposite.
A caller that trusted the completion message — a reasonable thing to do — would
approve a batch that leaves the same legal document self-contradictory: a
summary fact line reading 30 directly above prose reading 14. For a policy
document, that is a substantive defect, not a cosmetic one.

This observation also narrows the earlier Issue 1 finding. Incomplete
occurrence coverage had previously been seen only on unpinned, multi-document
requests, which left open the theory that cross-document routing was the cause.
This run used a single document with explicit `document_id` pinning, and the
omitted occurrence was quoted in the instruction — so routing is not a
necessary condition for the incompleteness.

### Evidence

A sanitized, redacted snapshot of the proposal batch was captured
automatically before any review decision was submitted, and is preserved
locally (git-ignored, not included in this repository) at the path documented
in `PROGRESS.md`. It contains only proposal-shaped fields plus a local
structural classification, with secret-shaped values redacted and restrictive
file permissions. Read-only verification afterward confirmed the document was
never modified.

### Reproduction

1. Upload a Terms of Service document containing all three of:
   `Return window (days): 30`, `within 30 days of delivery`, and
   `30-day window`.
2. Start an async chat request with `document_id` explicitly pinned to that
   document.
3. Instruct: change 30 days to 14 days; update **every** occurrence; name both
   the summary fact line and the body prose explicitly; require that no
   30-day return-window occurrence remain.
4. Poll the job to `awaiting_approval`.
5. Inspect `pending_changes` before submitting any review decision.
6. Observe that the body prose receives a proposal while the summary fact
   occurrence receives none.
7. Observe the completion-style message claiming the update is complete.
8. Deny every pending change.

### PolicySet mitigation

PolicySet does not fix this behavior; it mitigates it. Before any approval,
PolicySet enumerates every required occurrence of the managed fact in the
authoritative document and requires each one to be covered by a proposal that
performs the correct before-to-after transition. A batch missing any required
occurrence fails closed: every pending change in it is explicitly denied, and
the canonical `PolicyProfile` is left untouched. The canonical value is only
updated after the *final authoritative document* — re-read from the provider,
not inferred from job status — passes validation. The completion-style message
is treated as narrative text and is never used as a correctness signal.

In this run those checks worked as intended: the batch was denied, the
document remained at 30, and no partial commit occurred.

### Remaining limitation

Deterministic coverage is only as good as the occurrence model behind it. Each
new managed fact needs its occurrence patterns defined explicitly, and prose
phrasings the model can produce but the occurrence model does not anticipate
would not be enumerated. Coverage checking also cannot make an incomplete edit
complete — it can only refuse it — so a caller still has no reliable way to
obtain a complete multi-occurrence edit other than proposing, checking, and
denying.

### Classification / confidence

`SUPERDOCS_ROUGH_EDGE` / possible bug, moderate-to-high confidence in the
observed behavior. The partial edit and the contradicting completion text are
both directly evidenced, under a more controlled configuration than Issue 1
(pinned, single document, every occurrence named). We stop short of calling it
a confirmed API bug: exhaustive occurrence coverage is not a documented
guarantee, and this may be model behavior rather than an API contract
violation. One observed job.

### Report recommendation

Worth reporting to SuperDocs, with the completion-message contradiction called
out as the more actionable half: a caller can defend against an incomplete edit
if the response does not assert completeness, but a completion claim that
disagrees with the accompanying `pending_changes` batch is actively misleading
and is fixable independently of edit-generation quality.
