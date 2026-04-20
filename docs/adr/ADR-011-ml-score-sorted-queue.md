# ADR-011: ML score-sorted ion annotation queue

**Date:** 2026-04-20
**Status:** Accepted

## Context

PeakMe annotation queues previously returned ions in upload order (original `sort_order`
from the Cardinal export). This is arbitrary from a biological standpoint — annotators
spent significant effort labelling obvious off-tissue noise before reaching
biologically relevant ions.

Research phases 1–4 (see `research/report.md`) evaluated four classifiers on 35,084
human-annotated GCPL ions (human gastric cancer) plus cross-organism validation on a
mouse dataset. MobileNet-V3-Small (pretrained ImageNet, fine-tuned with class weights)
reached AUC 0.9283 on held-out human data and AUC 0.8793 on the held-out mouse dataset.
An active-learning re-simulation showed that scoring by P(on_tissue) descending reduces
the annotations needed to reach full dataset coverage by ~68% (8,606 vs 26,901).

## Decision

After a dataset finishes ingesting, a background job:

1. Fetches all ion images from S3 in parallel (ThreadPoolExecutor × 20)
2. Runs MobileNet-V3-Small ONNX inference in batches of 64 (CPU, onnxruntime)
3. Rewrites `ions.sort_order` to reflect ML rank (0 = highest P(on_tissue))
4. Stores the raw probability in the new `ions.ml_score` column

The queue endpoint (`GET /api/datasets/{id}/ions/queue`) already sorts by
`sort_order ASC` — no query changes are needed. Scoring is gated by the
`ML_MODEL_S3_KEY` env var; if unset, scoring is silently skipped and ions appear in
original upload order (safe to deploy before the model file is ready).

**Model:** `s3://peakme-ions/research/results/model_mobilenet_v3_small.onnx` (6.1 MB)  
**Architecture:** MobileNet-V3-Small, classifier head replaced with 2-class Linear  
**Output:** softmax probabilities; class index 1 = P(on_tissue)  
**Code:** `backend/app/services/ml_scoring.py`, hooked in `backend/app/routers/datasets.py`

**DB changes (migration 0005):**
- `ions.ml_score FLOAT NULLABLE` — raw P(on_tissue) score
- `datasets.matrix_type VARCHAR(50) DEFAULT 'DHAP'` — ionisation matrix identifier
- Index `ix_ions_dataset_ml_score` on `(dataset_id, ml_score DESC NULLS LAST)`

## Consequences

**Positive:**
- Annotators see biologically meaningful ions first with zero UI changes.
- ~68% reduction in annotations needed to reach full coverage.
- Model is optional at deploy time — `ML_MODEL_S3_KEY` unset → graceful fallback.
- No torch dependency in production; onnxruntime (~10 MB) only.
- ONNX session is a lazy singleton — model loaded from S3 once per process lifetime.

**Negative:**
- Scoring rewrites `sort_order` values after ingestion. Any cursor-paginated queue
  session open during scoring will see a discontinuity. In practice this is rare
  (scoring completes in ~4 min for 2,000 ions, well before a user opens the queue).
- Peak memory ~100 MB for a 2,000-ion dataset (50 KB/image × 2,000 images in RAM).
  For 10k+ ion datasets this should be streamed in batches in a future iteration.
- Model was trained on DHAP-matrix MSI data. Performance on other matrices (e.g.
  DHB, DAN) is unknown. The `matrix_type` column is added now to support future
  per-matrix model selection.

## Alternatives Considered

- **Add a separate `ml_sort_order` column:** Avoids rewriting `sort_order` but requires
  query changes in the queue endpoint and all cursor pagination logic. Rejected —
  rewriting `sort_order` in place keeps zero query changes and is safe given the
  timing window.
- **Run inference at request time (lazy per-ion):** Too slow for queue page load.
  Rejected.
- **Store scores only, sort in query:** Would require `ORDER BY ml_score DESC NULLS LAST`
  in queue endpoint. Rejected — keeping sort via `sort_order` means the queue strategy
  logic (unannotated_first, starred_first, all) is unchanged.
