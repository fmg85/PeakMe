# ADR-010: Ion identity contract — mz_value as the canonical matching key

**Date:** 2026-04-09
**Status:** Accepted

## Context

PeakMe is a two-way pipeline:

```
Cardinal (R) ──import──▶ PeakMe (annotate) ──export──▶ Cardinal (R)
```

The critical correctness requirement is that every annotation produced by PeakMe is
applied back to the **same ion** in the original Cardinal MSImagingExperiment, regardless
of:
- the order ions are displayed in the annotation queue (current: insertion order;
  future: ascending/descending m/z, random, starred-first, label-filter)
- how many users annotated
- whether the user re-annotated ions (upsert semantics, see ADR-005)

## Decision

The canonical identity link between a PeakMe annotation and a Cardinal ion is
**`mz_value` (IEEE-754 double precision)**, not:
- row position or `sort_order` (changes with any future queue reordering)
- PNG filename (truncated to 4 decimal places — lossy)
- `ion_id` UUID (synthetic PeakMe identifier, meaningless outside the database)

### How the chain works

| Step | What is stored / transmitted | Why it's safe |
|---|---|---|
| Cardinal → PNG filenames | `sprintf("%.4f.png", mz_val)` — 4 d.p. string | Filename is for S3 retrieval only, not identity |
| metadata.csv | `filename` + `mz_value` (full R double) | Full-precision double preserved in CSV |
| Backend ingestion | `Ion.mz_value` as PostgreSQL `float8` (64-bit IEEE-754) | Lossless: R double → float8 → Python float all use the same 64-bit IEEE-754 |
| Annotation storage | `Annotation.ion_id` → `Ion.id` UUID | Links to a specific ion record, not a position |
| CSV export | `ion.mz_value` via Python `csv.writer` | Python 3 `str(float)` produces the shortest decimal repr that round-trips to the same double |
| R import matching | Exact IEEE-754 equality first; nearest-neighbour ≤0.001 Da fallback | `peakme_export.R` lines 210–234 |

### Invariants that must be maintained

1. **`Ion.mz_value` is immutable** after ingestion. It must never be updated or normalised
   (e.g. rounded) in place.

2. **`sort_order` is a display hint only.** It is never included in the annotation export
   CSV/JSON and must never be used as a matching key on the R side. If UI sorting changes
   a user's queue order, annotations must still reference the same `ion_id` UUIDs.

3. **The CSV export must always include `mz_value`** (currently enforced in
   `backend/app/routers/annotations.py`). Removing it would silently break all R imports.

4. **Float serialisation must preserve full precision.** Python's `csv.writer` does this
   by default in Python 3. Do not format `mz_value` with `f"{mz:.4f}"` or similar —
   that would reduce precision to match the filename and could cause mismatches for ions
   whose m/z values are identical when rounded to 4 d.p.

## Consequences

**Positive:**
- Queue reordering (ascending/descending m/z, random, starred-first) is safe to implement
  without any changes to the export pipeline.
- Multi-user annotations are correctly disambiguated per ion regardless of annotator order.
- The nearest-neighbour fallback in `peakme_export.R` handles minor floating-point
  discrepancies with an explicit warning, so mismatches are never silent.

**Negative:**
- If two Cardinal ions have m/z values that are identical at full IEEE-754 double
  precision (extremely rare in practice), `peakme_export.R` warns and uses the first
  match. This is a Cardinal data quality issue, not a PeakMe issue.
- The guarantee relies on Python 3's `str(float)` round-trip behaviour. Do not
  downgrade to Python 2 or change the CSV serialisation without re-validating.

## What to check when adding new features

| Feature | Check |
|---|---|
| New queue sort order | Does annotation still reference `ion_id`? (yes → safe) |
| New export field | Never add `sort_order` to R-facing exports |
| Ion model migration | Never modify or re-normalise `mz_value` in existing rows |
| New import format | Must map to `mz_value` as the identity key, not filename or index |
