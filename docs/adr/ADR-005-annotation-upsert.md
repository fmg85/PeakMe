# ADR-005: UNIQUE(ion_id, user_id) with upsert semantics on annotations

**Date:** 2026-03-27
**Status:** Accepted

## Context

Scientists annotate ion images and frequently change their mind — either immediately after labeling or during a later review session. The data model must handle this gracefully.

## Decision

The `annotations` table has a `UNIQUE(ion_id, user_id)` constraint. The `POST /api/ions/:id/annotate` endpoint uses **upsert semantics** (`INSERT ... ON CONFLICT DO UPDATE`): calling it again overwrites the previous annotation for that user on that ion, updating `label_name`, `label_option_id`, `confidence`, `time_spent_ms`, and `updated_at`.

`DELETE /api/ions/:id/annotate` removes the annotation entirely (undo).

## Consequences

**Positive:**
- At most one annotation per (ion, user) pair: clean, predictable
- Re-labeling works naturally — no duplicate rows accumulate
- `updated_at` tracks when the last change was made (useful for audit/history)
- Export is unambiguous: one row per annotator per ion

**Negative:**
- No full annotation history (previous labels before revision are not stored)
- If audit trail of every label change is needed in the future, add an `annotation_history` table

## Alternatives Considered

- **Append-only model:** Store every annotation event with a timestamp; take the latest per (ion, user) for display. More complex queries, more rows. Overkill for Phase 1 — deferred to Phase 2 if audit trail is required.
