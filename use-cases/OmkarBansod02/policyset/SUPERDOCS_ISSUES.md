# SuperDocs issues observed during PolicySet development

This document records SuperDocs behavior PolicySet observed during live testing
that looked like a rough edge or a possible bug in the SuperDocs API, separate
from PolicySet's own application logic. It is written conservatively: nothing
here is claimed as a confirmed, reproducible SuperDocs defect unless the
evidence for that specific claim is unambiguous from a single artifact. Where
confidence is lower, that is stated explicitly.

Both issues below were observed while building PolicySet's synchronized
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
