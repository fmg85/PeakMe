# ML-Assisted Ion Image Pre-Classification — Research Report

> **Status:** In progress  
> **Started:** 2026-04-19  
> **Ionisation matrix in scope:** DHAP (all current data)

---

_This report is built up incrementally across research sessions. Sections are added as phases complete._

## 1. Executive Summary

_To be written after all phases complete._

## 2. Literature Context

Full review in `results/00_literature.md`. Key points:

**OffsampleAI (Ovchinnikova et al. 2020, BMC Bioinformatics)** is the most directly relevant prior work. It addresses an essentially identical binary task — off-sample (matrix/noise) vs. on-sample (biological signal) ion image classification — using ResNet-50 pretrained on ImageNet, fine-tuned on 23,238 labelled images from 87 METASPACE datasets. Achieved F1 = 0.97. Model and dataset publicly available at https://github.com/metaspace2020/offsample. Phase 3 uses these weights as a pretraining starting point.

**METASPACE** uses a spatial chaos score (component of the MSM score) as an implicit image quality filter. This is conceptually similar to our spatial_cv and gradient_mean features, validating that spatial structure is the key discriminating signal. METASPACE-ML (2024) adds a GBDT for context-specific FDR but does not expose standalone image quality scores.

**Active learning crossover:** Without pretraining, AL reliably beats random sampling after ~200–500 labels. With OffsampleAI pretraining (similar domain), estimated crossover drops to ~50–100 labels. Below ~50 labels, coreset/diversity sampling is more reliable than uncertainty sampling.

**DHAP matrix specifics:** No published comprehensive DHAP cluster m/z list exists — this is a gap PeakMe data can address. Known cluster ions: [DHAP-H]⁻ ≈ 151.04, [2DHAP-H]⁻ ≈ 303.09, [3DHAP-H]⁻ ≈ 455.13. Key artefact pattern: DHAP volatility under vacuum creates scan-direction intensity gradients during long acquisition runs.

## 3. Data Findings

Full audit in `results/01_data_audit.json`.

**Dataset overview:**

| Project | Organism | Datasets | Total ions | Off tissue | On tissue | Unclear |
|---|---|---|---|---|---|---|
| GCPL | Human (gastric cancer preneoplastic lesions) | 5 | 30,012 | 84.6% (25,395) | 15.0% (4,511) | 0.4% (106) |
| 65DNeoInfM3_10_test | Mouse (infected stomach, H. pylori) | 1 | 5,072 | 49.3% (2,502) | 49.2% (2,496) | 1.5% (74) |
| **Total** | | **6** | **35,084** | **79.5% (27,897)** | **20.0% (7,007)** | **0.5% (180)** |

**Class imbalance:** Overall off:on ratio = 3.98:1. GCPL alone = 5.64:1. Mouse dataset is nearly balanced (~1:1). Training requires class weighting or stratified sampling, especially for GCPL. The mouse dataset serves as a natural cross-organism test set.

**Cross-organism m/z overlap:** Only 8.46% of human unique m/z values appear in mouse data (±1 mDa tolerance); 28.98% of mouse m/z values appear in human. The low overlap means cross-organism transfer cannot rely on m/z identity — the model must learn visual image patterns (spatial structure, texture) that generalise across organisms.

**DHAP artefact candidates:** Top m/z values consistently labelled off-tissue across multiple datasets — m/z 254.0854, 254.0586, 324.0935, 310.0788, 329.0408 each appear as off-tissue in 4/6 datasets (66.7%). These are candidate DHAP cluster or adduct ions.

**Data quality notes:** No time_spent_ms data available (all null). No confidence scores for GCPL. Mouse has HP-associated labels (65 ions, ~1.3%) — mapped to on_tissue (biologically verified H. pylori signal). HP-associated is absent from GCPL data.

## 4. Label Semantics

- **On tissue:** Biologically relevant ion signal from the tissue specimen — spatially structured signal that correlates with tissue anatomy, visible as organised patterns in the ion image
- **Off tissue:** Chemical noise — DHAP matrix ions, ions uniformly distributed across the full sample area, signals not originating from tissue biology
- **Unclear:** Ambiguous; cannot be reliably classified by eye — handled as the model's low-confidence zone (max(p_on, p_off) < θ), not a trained class. The threshold θ is a product parameter chosen post-training based on calibration analysis.
- **HP-associated** (mouse project only): Ions associated with Helicobacter pylori infection pattern — treated as on_tissue for training purposes (biologically real signal, confirmed by user).

## 5. Baseline Results

Full results in `results/02_baseline_stats.json`. Evaluated on a stratified sample of 1,000 images (500/class) with 5-fold cross-validation.

**11 hand-crafted features:** mean_intensity, std_intensity, max_intensity, fg_fraction (foreground pixel fraction), hist_entropy (Shannon entropy of intensity histogram), spatial_cv (spatial coefficient of variation), center_periphery_ratio, gradient_mean (Sobel), laplacian_var (sharpness), quadrant_std (scan artefact detector), hv_ratio (horizontal/vertical gradient ratio).

| Model | F1 (mean ± std) | AUC |
|---|---|---|
| Logistic Regression | 0.7328 ± 0.0101 | 0.8158 |
| Decision Tree (depth=6) | 0.7044 ± 0.0248 | 0.7255 |

**Interpretation:** Simple hand-crafted image statistics already achieve F1 ≈ 0.73 without any deep learning. This is a meaningful result — it confirms that on-tissue vs off-tissue ions are visually distinguishable by spatial structure metrics. However, OffsampleAI achieved F1 = 0.97 on an analogous task, indicating significant headroom for deep learning. The AUC of 0.82 is particularly useful: it means the logistic regression score alone could rank ions reasonably well, suggesting even a simple heuristic could provide partial annotation efficiency gains.

**Operational implication:** A logistic regression on 11 image statistics could serve as a CPU-only fallback pre-filter at negligible cost, handling clear-cut cases while a GPU model handles the borderline ions.

## 6. Model Results

_See `results/03_model_metrics.json` — to be summarised here._

## 7. Active Learning Results

_See `results/04_al_curves.json` — to be summarised here._

## 8. Architecture Recommendation

_To be written after phases 3–5 complete._

## 9. Risks and Limitations

_To be written._

## 10. Next Steps

_To be written — concrete implementation plan for the engineering phase._
