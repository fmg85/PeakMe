# PeakMe ML Research — Session State

> This file is the source of truth for cross-session continuity.  
> Update it at the end of **every** session — even partial ones.  
> It must contain enough substance to reconstruct context if a session is interrupted mid-phase.

---

## Current Status

| Field | Value |
|---|---|
| **Active phase** | Phase 0.5 — Literature Review |
| **Last updated** | 2026-04-19 |
| **Last session outcome** | Repository scaffolded; research workstream initialised |
| **Next immediate action** | Run literature review (Metaspace, MSI ML papers, DHAP artefacts, active learning benchmarks) |

---

## AWS Resources

| Resource | Details | Status |
|---|---|---|
| EC2 instance | Not yet created | — |
| S3 research folder | Bucket: TBD (us-west-1); prefix: PeakMe Research/ | To confirm |
| Annotations CSV | Uploaded by user — path TBD | To confirm |
| Ion images | Bucket: `peakme-ions`, prefix: `datasets/{dataset_id}/` | Known |

> **Rule:** Always list instance ID and type here when an EC2 instance is running. Terminate before closing session.

---

## Research Data Summary

From codebase exploration (pre-experiment):

- ~30k annotated ions total, majority from human project(s)
- Mouse project also has annotations, expandable
- Labels: **on tissue** (biological), **off tissue** (chemical noise, incl. DHAP matrix ions), **unclear**
- Ionisation matrix: **DHAP** (2,5-Dihydroxyacetophenone) — all current data
- Ion images: PNG, 720×720 or 400×400 px, viridis colormap, stored at `s3://peakme-ions/datasets/{dataset_id}/{mz:.4f}.png`
- Annotations CSV schema: `ion_id, dataset_id, mz_value, image_key, sort_order, dataset_name, sample_type, project_name, label_name, confidence, time_spent_ms, annotated_at`

---

## Preliminary Findings

_None yet — research not started._

---

## Decisions Made

| Decision | Rationale |
|---|---|
| Binary classifier (on vs off tissue), not 3-class | "Unclear" is the model's low-confidence zone, not a trained class; avoids noisy label signal |
| Test active learning at N = 10, 100, 500, 1000, 2000, 5000 | User wants to know the practical "critical mass" threshold |
| Architecture must include `matrix_type` field | Future projects will use other matrices (DHB, CHCA, etc.); avoid DHAP hard-coding |
| Literature review before AWS spin-up | Findings may change model selection and data strategy |
| Plan checkpoint after literature review | Before committing to experiments, revise plan if lit review changes scope |

---

## Open Questions

1. What is the exact S3 bucket name and path for the PeakMe Research folder?
2. What are the exact project names and dataset names in the CSV (to confirm organism labelling)?
3. Are there any existing image quality scores or metadata from Metaspace for these same datasets?

---

## Phase Log

| Phase | Status | Key Finding |
|---|---|---|
| 0 — Scaffolding | ✅ Complete | research/ folder created, CLAUDE.md updated |
| 0.5 — Literature review | 🔄 In progress | — |
| 1 — Data audit | ⏳ Pending | — |
| 2 — Image statistics baseline | ⏳ Pending | — |
| 3 — Transfer learning | ⏳ Pending | — |
| 4 — Active learning simulation | ⏳ Pending | — |
| 5 — Operational analysis | ⏳ Pending | — |
| 6 — Research report | ⏳ Pending | — |
