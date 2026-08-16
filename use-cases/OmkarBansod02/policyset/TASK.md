# PolicySet tasks

PolicySet is a synchronized four-document policy-set editor for a fictional physical-goods ecommerce store (Northstar Goods).

PolicySet owns canonical facts and consistency. SuperDocs will later own document editing, review, and export. AI will later own language edits. Humans approve changes.

## Phase 1 — Deterministic domain core

Typed profile, four document types, Northstar fixture, explicit fact-to-document registry, ChangeSet transactions that do not mutate the canonical profile until an approved commit, deterministic HTML renderers, and a consistency validator. No SuperDocs calls and no editor UI.

## Phase 2 — SuperDocs session and four-document workspace

Deterministic DOCX generation from PolicyProfile, a minimal production SuperDocs adapter, and a local preview/upload script. No intake/workspace UI, HITL review, or synchronized ChangeSet execution.

## Phase 3 — Guided intake and four-document workspace

Intake UI, deterministic generation, and a four-document preview workspace. No SuperDocs calls, HITL, or synchronized ChangeSet execution.

## Phase 4 — Export

Not started.
