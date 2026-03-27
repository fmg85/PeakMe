# ADR-006: label_name denormalized on annotations

**Date:** 2026-03-27
**Status:** Accepted

## Context

Project admins can rename label options (e.g. "Organ A" → "Liver"). If the `annotations` table stored only `label_option_id` as a foreign key, exports generated after a rename would silently reflect the new name — misrepresenting what the scientist actually saw and chose at annotation time.

## Decision

Store `label_name TEXT NOT NULL` directly on each `annotations` row in addition to `label_option_id`. The name is copied from the `label_options.name` value at the moment of annotation (not at export time).

## Consequences

**Positive:**
- Exports are historically accurate: the label name in a CSV always reflects what was shown to the annotator
- Robust to label renaming, reordering, or deletion
- Queries for "all annotations labeled X" can filter on `label_name` without joining `label_options`

**Negative:**
- Slight data redundancy (name stored in two places)
- If admin wants to retroactively rename all annotations (intentional bulk relabel), they must do so explicitly — no cascade

## Scope

`label_option_id` is still stored (nullable on delete of label option) for UI purposes: if the original label option still exists, the UI can highlight which button was previously selected. If the label option was deleted, `label_option_id` is null but `label_name` still has the original string.
