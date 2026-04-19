# PeakMe ML Research — Session State

> This file is the source of truth for cross-session continuity.  
> Update it at the end of **every** session — even partial ones.  
> It must contain enough substance to reconstruct context if a session is interrupted mid-phase.

---

## Current Status

| Field | Value |
|---|---|
| **Active phase** | Phase 3 — Transfer Learning (waiting for GPU quota) |
| **Last updated** | 2026-04-19 |
| **Last session outcome** | Phases 1-2 complete. Phase 3 CPU run launched on i-099420ac04180723f. Script runs models one by one (MobileNet→ResNet18→EfficientNet→ResNet50), checks GPU quota between each, stops early if quota approved. |
| **Next immediate action** | Monitor Phase 3 progress. Terminate i-099420ac04180723f when complete or if GPU quota approved. |

---

## AWS Resources

| Resource | Details | Status |
|---|---|---|
| EC2 CPU (c5.4xlarge) | i-099420ac04180723f, us-west-1 — **RUNNING** Phase 3 (incremental, CPU). Terminate when phase3_status.txt = CPU_COMPLETE or GPU_QUOTA_APPROVED | ⚠️ Active |
| EC2 GPU (g4dn.xlarge) | G-family on-demand quota request ID: f6ead070f62445759576d94d2a52c6456dBfJlSk — CASE_OPENED | Pending |
| EC2 GPU (p3.2xlarge) | P-family on-demand quota request ID: 20ad2b4e799343d4bbedcff0a0762db158Wy2nAG — PENDING | Pending |
| S3 annotations CSV | `s3://peakme-ions/research/annotations.csv` (9.3 MB) | ✅ Confirmed |
| S3 results | `s3://peakme-ions/research/results/` — 01_data_audit.json, 02_baseline_stats.json, 02_image_features.csv | ✅ Uploaded |
| S3 scripts | `s3://peakme-ions/research/scripts/` — all phase scripts uploaded | ✅ Uploaded |
| S3 models folder | `s3://peakme-ions/research/models/` (empty, ready for artifacts) | ✅ Confirmed |
| Ion images | `s3://peakme-ions/datasets/{dataset_id}/{mz:.4f}.png` | ✅ Confirmed |

> **Rule:** Always list instance ID and type here when an EC2 instance is running. Terminate before closing session.

---

## Research Data Summary

From Phase 1 (full data audit, 2026-04-19):

- **35,084** total annotated ions, 0 unannotated
- Binary: **off_tissue = 27,897** (79.5%), **on_tissue = 7,007** (20.0%), unclear = 180 (0.5%)
- Overall off:on ratio = **3.98:1**
- 6 datasets across 2 projects
- Labels: **on tissue** (biological), **off tissue** (chemical noise, incl. DHAP matrix ions), **unclear**
- Ionisation matrix: **DHAP** (2,5-Dihydroxyacetophenone) — all current data
- Ion images: PNG, viridis colormap, stored at `s3://peakme-ions/datasets/{dataset_id}/{mz:.4f}.png`
- Annotations CSV schema: `ion_id, dataset_id, mz_value, image_key, sort_order, dataset_name, sample_type, project_name, label_name, confidence, time_spent_ms, annotated_at`

---

## Preliminary Findings

### Phase 0 — Data audit from DB (preliminary, before EC2)

**Projects confirmed for research (ignoring test/toy projects):**

| Project | Organism | Datasets | Total ions | Off tissue | On tissue | Unclear | Other |
|---|---|---|---|---|---|---|---|
| **GCPL** | Human (Gastric Cancer PreNeoplastic Lesions) | 5 (gpcl551, gpcl611, gpcl852, gpcl858, gpcl968) | 30,012 | 84.6% (25,395) | 15.0% (4,511) | 0.4% (106) | — |
| **65DNeoInfM3_10_test** | Mouse (infected stomach) | 1 (65D_m3_sl10) | 5,072 | 49.3% (2,502) | 49.2% (2,496) | 1.5% (74) | — |

**Total research-grade annotated ions: 35,084**

**Key observations:**
- GCPL has severe class imbalance: 5.64:1 off-tissue vs on-tissue. Must use class weights or stratified sampling.
- Mouse dataset is nearly balanced (49.3% / 49.2%) — better for unbiased initial training.
- `sample_type` is null for all GCPL datasets — organism info is in project name only.
- `confidence` and `time_spent_ms` are null for most GCPL annotations (no time_spent_ms data at all).
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

**Architecture update — 4-model comparison**
1. ResNet-50 with OffsampleAI pretrained weights (new addition — closest prior work)
2. EfficientNet-B0 with ImageNet weights
3. ResNet-18 with ImageNet weights
4. MobileNetV3-Small with ImageNet weights

### Phase 1 — Data Audit (complete, 2026-04-19)

**Results file:** `research/results/01_data_audit.json`

| Metric | Value |
|---|---|
| Total annotated ions | 35,084 |
| Binary off:on ratio | 3.98:1 (off=27,897 / on=7,007) |
| GCPL off:on ratio | 5.64:1 (off=25,395 / on=4,511) |
| Mouse off:on ratio | 1.00:1 (off=2,502 / on=2,496) |
| Cross-organism m/z overlap | 8.46% of human mz found in mouse; 28.98% of mouse in human (±1 mDa) |
| time_spent_ms data | None (all null) |

**DHAP artefact candidates (top by dataset prevalence):**
- m/z 254.0854, 254.0586, 324.0935, 310.0788, 329.0408 — each off-tissue in 4/6 datasets (66.7%)
- Full top-50 list in `01_data_audit.json`

**Key implication for model:** Cross-organism overlap is low (8-29%), so transfer relies on learning visual image patterns (spatial structure, texture) not m/z identity.

### Phase 2 — Image Statistics Baseline (complete, 2026-04-19)

**Results file:** `research/results/02_baseline_stats.json`

| Model | F1 (5-fold CV) | AUC |
|---|---|---|
| Logistic Regression (11 features) | 0.7328 ± 0.0101 | 0.8158 |
| Decision Tree (depth=6) | 0.7044 ± 0.0248 | 0.7255 |

**11 hand-crafted features:** mean_intensity, std_intensity, max_intensity, fg_fraction, hist_entropy, spatial_cv, center_periphery_ratio, gradient_mean, laplacian_var, quadrant_std, hv_ratio

**Key insight:** Simple image statistics achieve F1≈0.73 without any deep learning. This is a strong baseline — deep learning must beat this to justify the added complexity. Given OffsampleAI achieved F1=0.97 on the same task, we expect significant headroom.

**Per-project training F1:** GCPL (n=790) = 0.7055, Mouse (n=210) = 0.734. Mouse slightly easier likely due to better class balance.

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
| HP-associated = on tissue | Biologically real Helicobacter pylori signal, confirmed by user |
| GCPL = human, Gastric Cancer PreNeoplastic Lesions | Confirmed by user |
| 4-model comparison: add ResNet-50/OffsampleAI to original 3 | Keep EfficientNet-B0, ResNet-18, MobileNetV3-Small from original plan plus OffsampleAI comparison |
| Scripts delivered via S3, not GitHub | Push credentials unavailable from dev machine; EC2 downloads from s3://peakme-ions/research/scripts/ |

---

## Open Questions

~~1. S3 path?~~ `s3://peakme-ions/research/annotations.csv` ✅
~~2. Project/dataset names?~~ Confirmed via DB queries ✅
3. Any Metaspace scores for these datasets? (nice-to-have, not blocking)
~~4. GCPL = ?~~ Gastric Cancer PreNeoplastic Lesions — human tissue ✅
~~5. HP-associated label?~~ Treat as "on tissue" ✅

---

## Phase Log

| Phase | Status | Key Finding |
|---|---|---|
| 0 — Scaffolding | ✅ Complete | research/ folder created, CLAUDE.md updated |
| 0.5 — Literature review | ✅ Complete | OffsampleAI (F1=0.97, 23k public images) is key prior work; plan updated |
| 0.6 — Download OffsampleAI dataset | ⏳ Pending (needs GPU instance) | — |
| 1 — Data audit | ✅ Complete | 35,084 ions; off:on = 3.98:1; cross-organism overlap 8-29%; DHAP artefact candidates identified |
| 2 — Image statistics baseline | ✅ Complete | LogReg F1=0.7328, AUC=0.8158 — strong baseline without deep learning |
| 3 — Transfer learning | ⏳ Pending (GPU quota approval required) | — |
| 4 — Active learning simulation | ⏳ Pending | — |
| 5 — Operational analysis | ⏳ Pending | — |
| 6 — Research report | ⏳ Pending | — |
