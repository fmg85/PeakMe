# PeakMe ML Research — Session State

> This file is the source of truth for cross-session continuity.  
> Update it at the end of **every** session — even partial ones.  
> It must contain enough substance to reconstruct context if a session is interrupted mid-phase.

---

## Current Status

| Field | Value |
|---|---|
| **Active phase** | Phase 1 — Data Audit (ready to start) |
| **Last updated** | 2026-04-19 |
| **Last session outcome** | Phase 0.5 lit review complete. Phase 0 data confirmed: CSV at s3://peakme-ions/research/annotations.csv (9.3 MB), ~35k annotated ions, 2 substantive projects confirmed. |
| **Next immediate action** | Spin up EC2 g4dn.xlarge (us-west-1) and run Phase 1 data audit + Phase 2 image statistics |

---

## AWS Resources

| Resource | Details | Status |
|---|---|---|
| EC2 instance | Not yet created | Pending |
| S3 annotations CSV | `s3://peakme-ions/research/annotations.csv` (9.3 MB) | ✅ Confirmed |
| S3 models folder | `s3://peakme-ions/research/models/` (empty, ready for artifacts) | ✅ Confirmed |
| Ion images | `s3://peakme-ions/datasets/{dataset_id}/{mz:.4f}.png` | ✅ Confirmed |

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

### Phase 0 — Data audit from DB (preliminary, before EC2)

**Projects confirmed for research (ignoring test/toy projects):**

| Project | Organism | Datasets | Total ions | Off tissue | On tissue | Unclear | Other |
|---|---|---|---|---|---|---|---|
| **GCPL** | Human (likely) | 5 (gpcl551, gpcl611, gpcl852, gpcl858, gpcl968) | 30,012 | 84.6% (25,395) | 15.0% (4,511) | 0.4% (106) | — |
| **65DNeoInfM3_10_test** | Mouse (infected stomach) | 1 (65D_m3_sl10) | 5,072 | 49.3% (2,502) | 47.9% (2,431) | 1.5% (74) | 1.3% HP-associated (65) |

**Total research-grade annotated ions: ~35,084**

**Key observations:**
- GCPL has severe class imbalance: 5.7:1 off-tissue vs on-tissue. Must use class weights or stratified sampling.
- Mouse dataset is nearly balanced (~50/50) — better for unbiased initial training.
- "HP-associated" label (Helicobacter pylori-related ions) appears only in mouse project — treat as "on tissue" or separate class TBD.
- `sample_type` is null for all GCPL datasets — organism info is in project name only.
- `confidence` and `time_spent_ms` are null for most GCPL annotations.
- Label naming inconsistency: "unclear" (mouse) vs "Unclear" (GCPL) — normalize to lowercase in preprocessing.
- CSV schema confirmed: `ion_id, dataset_id, mz_value, image_key, sort_order, dataset_name, sample_type, project_name, label_name, confidence, time_spent_ms, annotated_at`
- S3 image key format: `datasets/{dataset_id}/{mz:.4f}.png`

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
4. What does "GCPL" stand for? (To confirm organism/tissue type for documentation)
5. Should "HP-associated" label be treated as "on tissue" (it's a biological signal) or as a separate category?

---

## Phase Log

| Phase | Status | Key Finding |
|---|---|---|
| 0 — Scaffolding | ✅ Complete | research/ folder created, CLAUDE.md updated |
| 0.5 — Literature review | ✅ Complete | OffsampleAI (F1=0.97, 23k public images) is key prior work; plan updated |
| 0.6 — Download OffsampleAI dataset | ⏳ Pending (on EC2) | — |
| 1 — Data audit | 🔄 Partially done (DB queries); full audit on EC2 pending | GCPL: 30k ions, 85% off-tissue; Mouse: 5k, ~50/50 |
| 2 — Image statistics baseline | ⏳ Pending | — |
| 3 — Transfer learning | ⏳ Pending | — |
| 4 — Active learning simulation | ⏳ Pending | — |
| 5 — Operational analysis | ⏳ Pending | — |
| 6 — Research report | ⏳ Pending | — |
