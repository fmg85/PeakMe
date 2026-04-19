# Literature Review: ML Pre-Classification of MSI Ion Images

_Completed: 2026-04-19_

---

## TL;DR — Key Findings

1. **OffsampleAI (Ovchinnikova et al. 2020)** is the single most relevant prior work. It solves almost the same binary classification task (off-sample vs. on-sample ion images) using ResNet-50 pretrained on ImageNet, achieving F1 = 0.97 on 23,238 labelled images from 87 METASPACE datasets. The dataset and model are publicly available at https://github.com/metaspace2020/offsample. **This should be our pretraining starting point.**

2. **METASPACE** already computes a spatial chaos score (structuredness of ion images) as part of its FDR pipeline. It is not exposed as a standalone quality filter but is the closest existing tool. The METASPACE Python API provides access to millions of ion images with weak labels (FDR, MSM score) — usable as pretraining corpus.

3. **ImageNet → MSI transfer works well.** OffsampleAI demonstrated F1=0.97 with standard ResNet-50 ImageNet weights, despite the domain difference. No domain-specific MSI pretraining is necessary to get very strong performance.

4. **Active learning crossover**: Without pretraining, AL beats random sampling after ~200–500 labels. **With OffsampleAI pretraining, this threshold is likely 50–100 labels.** Below ~50 labels per class, uncertainty-based AL may be worse than random (overconfident/poorly-calibrated model). Use coreset/diversity sampling for the first ~100 labels.

5. **DHAP-specific cluster m/z table does not exist** in the published literature. Known approximate values: [DHAP-H]⁻ m/z ≈ 151.04; [2DHAP-H]⁻ ≈ 303.09; [3DHAP-H]⁻ ≈ 455.13. PeakMe's own annotation data could contribute the first published DHAP artefact list.

---

## 1. METASPACE

### What is METASPACE?
Cloud platform for FDR-controlled metabolite annotation of MSI data. Assigns molecular formula annotations to detected ion images using a target-decoy FDR scheme.

**Key paper:** Palmer et al. 2017, *Nature Methods* — DOI: 10.1038/nmeth.4072

### Does METASPACE score image quality?
Yes — implicitly. The **MSM (metabolite-signal match) score** has three components:
- **Spatial chaos measure** (0–1): penalises unstructured/salt-and-pepper images. Effectively a quality pre-filter.
- **Spatial isotope measure**: co-localisation between monoisotopic and first isotope images.
- **Spectral isotope measure**: intensity ratio match to theoretical isotope envelope.

The chaos score alone is a usable heuristic for separating structured (on-tissue biological) from diffuse/uniform (off-tissue noise) ion images. It is comparable to our baseline image statistics approach.

### METASPACE-ML (2024)
**Wadie et al. 2024, *Nature Communications* — DOI: 10.1038/s41467-024-52213-9**
- Replaces MSM score thresholds with a Gradient Boosting Decision Tree trained as a ranking model (PairLogit loss), making FDR estimation tissue/organism-specific.
- Training data: 1,710 datasets from 159 researchers.
- Does not provide a standalone "is this image signal or noise" classifier — improvements are in annotation FDR, not image quality scoring.
- Open source (part of METASPACE codebase).

### METASPACE API
Python client (`metaspace2020` on PyPI) exposes:
- Per-dataset annotations with FDR and MSM score
- Ion image downloads as numpy arrays
- Metadata: tissue type, organism, ionisation mode, matrix

This is a viable **large-scale pretraining corpus** of weakly-labelled MSI ion images.

---

## 2. OffsampleAI — Most Directly Relevant Prior Work

**Ovchinnikova et al. 2020, *BMC Bioinformatics* — DOI: 10.1186/s12859-020-3425-x**  
GitHub: https://github.com/metaspace2020/offsample

### Task
Binary classification: does the ion image show intensity primarily **outside** the tissue boundary (off-sample) or **within** tissue (on-sample)?

Off-sample ions = matrix background, contaminants, noise distributed across the glass slide. On-sample = biologically-located signal.

**This maps almost exactly to PeakMe's "off tissue" vs "on tissue" distinction.**

### Dataset
- 23,238 ion images manually labelled by experts
- From 87 public METASPACE datasets
- Publicly available

### Architecture & Performance

| Method | F1 |
|---|---|
| ResNet-50 (ImageNet pretrained) | **0.97** |
| Semi-automated spatio-molecular biclustering | 0.96 |
| Molecular co-localisation | 0.90 |
| Spatial chaos only | ~0.70 (estimated) |

ResNet-50 pretrained on ImageNet, fine-tuned with fastai/PyTorch.

### Key implication for PeakMe
- The OffsampleAI model can serve as our **pretrained starting point**, reducing the cold-start data requirement significantly.
- Fine-tuning on PeakMe's own annotations (DHAP-specific, organ-specific) should push accuracy further.
- The task difference: OffsampleAI uses "outside tissue boundary" as definition; PeakMe uses "biologically relevant" (which also excludes matrix ions on tissue). There is partial overlap but the labels are not identical.

---

## 3. Other ML/MSI Papers

### Tumor tissue classification
- **Behrmann et al. 2018, *Bioinformatics***: Custom CNN on raw 1D spectra per pixel, 84–89% balanced accuracy for tumor subtype classification (MALDI). Different task (pixel-level, not ion image level).
- **massNet 2022**: VAE + FC layers for normal vs. tumour tissue in GBM mouse model. ~15k spectra.
- **Weakly supervised MIL (Gardner 2024, *Small Methods*)**: DSMIL, 98.7% on MALDI imaging tissue classification with only image-level labels. Relevant if PeakMe annotations remain at ion-image level.

### Representation learning
- **DeepION 2024, *Analytical Chemistry***: ResNet-18 contrastive self-supervised learning for ion colocalization/isotope identification. ~2,200 images, 87–93% accuracy. Code available. Potential pretraining option if OffsampleAI proves too different.
- **msiPL 2021, *Nature Communications***: FC-VAE for unsupervised tissue segmentation. Not directly relevant to classification task but useful for spatial feature extraction.

### Denoising / statistical tools
- **SPUTNIK (Inglese 2019, *Bioinformatics*)**: R package for spatially automatic denoising using spatial chaos + Gini index + co-localisation with reference image.
- **moleculaR (Guo 2023, *Nature Communications*)**: Probabilistic spatial significance testing for metabolite ensembles.

---

## 4. DHAP Matrix Artefacts

### Background
DHAP (2,5-Dihydroxyacetophenone) is a negative-ion mode MALDI matrix effective for gangliosides, phospholipids (PE especially), and other anionic lipids.

### Known artefact patterns
1. **Volatility / scan-direction gradient**: DHAP evaporates under high-vacuum MALDI, causing progressive intensity decrease over long scans. Artefact ions show intensity gradients aligned with scan direction, not tissue anatomy.
2. **Matrix cluster ions** (low m/z, typically < 400 Da):
   - [DHAP-H]⁻ at m/z ≈ 151.04
   - [2DHAP-H]⁻ at m/z ≈ 303.09
   - [3DHAP-H]⁻ at m/z ≈ 455.13
   - Adducts (Na+22, K+38, Cl+34) shift each of the above.
3. **PE/PC suppression confusion**: DHAP enhances PE ionisation in negative mode while suppressing PC, creating spatial patterns that reflect ionisation suppression, not biology.
4. **No published comprehensive DHAP cluster table** exists (unlike the 353-formula DHB list in OffsampleAI). This is a gap the PeakMe dataset could help fill.

### Implication for model
The model should learn DHAP-specific artefact signatures. When other matrices are introduced (DHB, CHCA, norharmane), the model will need to be retrained or fine-tuned per matrix — supporting the architecture decision to include a `matrix_type` field.

---

## 5. Active Learning for Bioimaging

### Key benchmarks

| Study | Domain | Labels needed vs. random | AL strategy |
|---|---|---|---|
| Radiology COVID (PMC 2023) | Chest X-ray | 5% labels → 93.1% acc (vs. benchmark 93.7%) | Uncertainty |
| Histology breast cancer (PMC 2023) | Pathology | 16% vs. 36% labels (56% reduction) | Uncertainty |
| Colonoscopy (PMC 2023) | Endoscopy | 400 vs. 1,000 labels | Uncertainty |
| HALS real-time (npj DM 2021) | Cell microscopy | 20–30 annotations per class | Hybrid |

### Key findings for PeakMe
- **AL crossover point**: Without pretraining, AL reliably beats random at ~200–500 labels. With OffsampleAI pretraining, this is likely 50–100 labels.
- **Very low budget (< 50 samples/class)**: Uncertainty-based AL may be *worse* than random (poorly calibrated predictions → bad uncertainty signals). Use **coreset / diversity sampling** for the first ~100 examples.
- **Recommendation**: Use two-phase strategy:
  1. Phase 1 (0 → 100 labels): coreset sampling (maximally diverse examples)
  2. Phase 2 (100+ labels): uncertainty sampling (entropy of softmax)

### Practical guidance for Phase 4 simulation
The simulation should test N = 10, 100, 500, 1000, 2000, 5000 as planned. Additionally:
- Compare uncertainty sampling vs. coreset sampling at N < 100
- With and without OffsampleAI pretraining, to quantify the pretraining benefit

---

## 6. Transfer Learning: ImageNet → MSI

### Evidence
- OffsampleAI: ResNet-50 ImageNet → MSI, F1 = 0.97 (**directly applicable**)
- Behrmann 2018: ImageNet features useful even for 1D spectral data (via 2D representations)
- Early CNN layers (edge detectors, Gabor-like filters) transfer across domains
- MicroNet (NASA, npj Comp Materials 2022): Domain-specific microscopy pretraining outperforms ImageNet for segmentation, but requires large microscopy dataset (>100k labelled images)

### Recommendation
1. **Primary approach**: Use OffsampleAI model (ResNet-50, public weights) as pretraining base. Fine-tune on PeakMe data.
2. **Alternative**: EfficientNet-B0 with ImageNet weights (if starting fresh without OffsampleAI compatibility).
3. **Do not** use MobileNetV3-Small as primary — too small for a task where F1=0.97 has already been demonstrated with a larger model.

### Architecture recommendation update (vs. original plan)
| Priority | Model | Params | Why |
|---|---|---|---|
| 1st | **ResNet-50 (OffsampleAI weights)** | 23.5M | Direct pretraining from closest existing labelled dataset |
| 2nd | **EfficientNet-B0** | 5.3M | Best accuracy/size if OffsampleAI pretraining not used |
| 3rd | **MobileNetV3-Small** | 2.5M | Operational inference only (after training with larger model) |

---

## Plan Checkpoint Notes

Based on this literature review, the following plan updates are recommended:

1. **Add OffsampleAI as Phase 0.6**: Download the public dataset (23k images) and optionally the pretrained model weights from GitHub. This changes Phase 3 significantly.
2. **Update Phase 3**: Add a pretraining comparison — ResNet-50 with OffsampleAI weights vs. ResNet-50 with ImageNet weights. This is the most important ablation.
3. **Update Phase 4 (AL simulation)**: Add coreset sampling baseline at N < 100. Add with/without OffsampleAI pretraining comparison.
4. **DHAP m/z list**: During Phase 1 (data audit), compute which m/z values are most commonly labelled "off tissue" — this produces the first empirical DHAP artefact list.
5. **METASPACE chaos score**: During Phase 2 (baseline), consider adding chaos score as a feature (if computable from ion images directly, or via the METASPACE API for matching ions).

---

## References

| Paper | DOI / Link |
|---|---|
| Palmer et al. 2017 (METASPACE) | 10.1038/nmeth.4072 |
| Ovchinnikova et al. 2020 (OffsampleAI) | 10.1186/s12859-020-3425-x |
| Wadie et al. 2024 (METASPACE-ML) | 10.1038/s41467-024-52213-9 |
| Guo et al. 2023 (moleculaR) | 10.1038/s41467-023-37394-z |
| Behrmann et al. 2018 (tumor CNN) | 10.1093/bioinformatics/btx724 |
| Gardner et al. 2024 (MIL MALDI) | 10.1002/smtd.202301230 |
| Abdelmoula et al. 2021 (msiPL) | 10.1038/s41467-021-25744-8 |
| DeepION 2024 | 10.1021/acs.analchem.3c05002 |
| Inglese et al. 2019 (SPUTNIK) | 10.1093/bioinformatics/bty622 |
| Stuckner et al. 2022 (MicroNet) | 10.1038/s41524-022-00878-5 |
| Fuchs et al. 2018 (DHAP PE/PC) | 10.1007/s00216-018-0926-9 |
| OffsampleAI GitHub | https://github.com/metaspace2020/offsample |
| METASPACE API docs | https://metaspace2020.readthedocs.io |
| NASA MicroNet GitHub | https://github.com/nasa/pretrained-microscopy-models |
