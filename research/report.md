# ML-Assisted Ion Image Pre-Classification — Research Report

> **Status:** In progress  
> **Started:** 2026-04-19  
> **Ionisation matrix in scope:** DHAP (all current data)

---

_This report is built up incrementally across research sessions. Sections are added as phases complete._

## 1. Executive Summary

_To be written after all phases complete._

## 2. Literature Context

_See `results/00_literature.md` — to be summarised here._

## 3. Data Findings

_See `results/01_data_audit.json` — to be summarised here._

## 4. Label Semantics

- **On tissue:** Biologically relevant ion signal from the tissue specimen — spatially structured, correlates with tissue anatomy
- **Off tissue:** Chemical noise — DHAP matrix ions, ions uniformly distributed across the sample, signals not from biology
- **Unclear:** Ambiguous; not a trained class — handled as the model's low-confidence zone (max(p_on, p_off) < θ)

## 5. Baseline Results

_See `results/02_baseline_stats.csv` — to be summarised here._

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
