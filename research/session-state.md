# PeakMe ML Research — Session State

> This file is the source of truth for cross-session continuity.  
> Update it at the end of **every** session — even partial ones.  
> It must contain enough substance to reconstruct context if a session is interrupted mid-phase.

---

## Current Status

| Field | Value |
|---|---|
| **Active phase** | Phase 0 — AWS Setup + Data Confirmation (plan checkpoint passed) |
| **Last updated** | 2026-04-19 |
| **Last session outcome** | Phase 0.5 literature review complete. OffsampleAI is a critical prior work — will be used as pretraining base. Plan checkpoint reviewed — see decisions below. |
| **Next immediate action** | 1. Confirm S3 bucket/path for PeakMe Research CSV. 2. Spin up EC2 g4dn.xlarge (us-west-1). 3. Download OffsampleAI dataset. |

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

### Phase 0.5 — Literature Review (complete)

**Most important finding: OffsampleAI (Ovchinnikova et al. 2020)**
- Same binary task: off-sample (noise/matrix) vs. on-sample (biological signal) ion image classification
- ResNet-50 pretrained on ImageNet → F1 = 0.97 on 23,238 labelled images from 87 METASPACE datasets
- Dataset and model publicly available: https://github.com/metaspace2020/offsample
- **Action**: Use OffsampleAI model weights as pretraining base in Phase 3

**METASPACE**
- Has a spatial chaos score as an implicit image quality filter (component of MSM score)
- Python API exposes ion images + FDR/MSM labels — viable additional pretraining corpus
- METASPACE-ML (2024) uses GBDT for context-specific FDR; does not expose standalone image quality scores

**Active learning crossover point**
- Without pretraining: AL reliably beats random after ~200–500 labels
- With OffsampleAI pretraining: estimated crossover at ~50–100 labels
- Below ~50 labels: use coreset/diversity sampling (uncertainty sampling unreliable at low N)

**DHAP artefacts**
- No published comprehensive DHAP cluster m/z list exists (gap PeakMe data can fill)
- Known approximate DHAP cluster ions: [DHAP-H]⁻ m/z ≈ 151.04; [2DHAP-H]⁻ ≈ 303.09; [3DHAP-H]⁻ ≈ 455.13
- Key artefact: DHAP volatility under vacuum → scan-direction intensity gradients in long runs

**Architecture update**
- Primary: ResNet-50 with OffsampleAI pretrained weights
- Alternative: EfficientNet-B0 with ImageNet weights
- MobileNetV3-Small: operational inference only (not training)

---

## Decisions Made

| Decision | Rationale |
|---|---|
| Binary classifier (on vs off tissue), not 3-class | "Unclear" is the model's low-confidence zone, not a trained class; avoids noisy label signal |
| Test active learning at N = 10, 100, 500, 1000, 2000, 5000 | User wants to know the practical "critical mass" threshold |
| Architecture must include `matrix_type` field | Future projects will use other matrices (DHB, CHCA, etc.); avoid DHAP hard-coding |
| Use OffsampleAI (ResNet-50) as pretraining base | Directly analogous task, F1=0.97, 23k public images — reduces cold-start data requirement significantly |
| Add Phase 0.6: download OffsampleAI dataset | Need public data for pretraining comparison and to understand label mapping |
| Coreset sampling for first ~100 AL labels | Uncertainty sampling unreliable at very low budgets; coreset is safer starting strategy |
| Add DHAP artefact m/z list as a data audit output | No published DHAP list exists; PeakMe annotations can contribute this |

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
| 0.5 — Literature review | ✅ Complete | OffsampleAI (F1=0.97, 23k public images) is key prior work; plan updated |
| 0.6 — Download OffsampleAI dataset | ⏳ Pending | — |
| 1 — Data audit | ⏳ Pending | — |
| 2 — Image statistics baseline | ⏳ Pending | — |
| 3 — Transfer learning | ⏳ Pending | — |
| 4 — Active learning simulation | ⏳ Pending | — |
| 5 — Operational analysis | ⏳ Pending | — |
| 6 — Research report | ⏳ Pending | — |
