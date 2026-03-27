# Cardinal → PeakMe Export Workflow

This guide walks you through exporting MSI data from Cardinal (R) into the PNG format required by PeakMe.

## Overview

PeakMe does not process raw mass spectrometry files server-side. Instead, you render ion images locally using Cardinal, then upload a ZIP of PNGs to PeakMe. This keeps the server lightweight and gives you full control over rendering parameters.

**Workflow:**
1. Install dependencies in R
2. Run `export_cardinal_pngs.R` on your data
3. Zip the output folder
4. Upload the ZIP to PeakMe and create a dataset

---

## 1. Install R Dependencies

In R or RStudio:

```r
if (!requireNamespace("BiocManager", quietly = TRUE))
  install.packages("BiocManager")

BiocManager::install("Cardinal")
install.packages(c("viridis", "optparse"))
```

---

## 2. Run the Export Script

Download `r-scripts/export_cardinal_pngs.R` from this repository.

### From an imzML file

```bash
Rscript export_cardinal_pngs.R \
  --input /path/to/your/data.imzML \
  --output ./peakme_export \
  --colormap viridis \
  --normalize tic \
  --zip
```

### From a saved .RData / .rda file

If you have already loaded and processed your MSImagingExperiment in R and saved it:

```r
# In R: save your experiment
save(msi_experiment, file = "my_experiment.RData")
```

```bash
Rscript export_cardinal_pngs.R \
  --input my_experiment.RData \
  --output ./peakme_export \
  --zip
```

If the .RData contains multiple objects, specify which one:

```bash
Rscript export_cardinal_pngs.R \
  --input my_experiment.RData \
  --object-name msi_experiment \
  --output ./peakme_export \
  --zip
```

### All Options

| Option | Default | Description |
|---|---|---|
| `--input` | *(required)* | Path to `.imzML` or `.RData` file |
| `--output` | `./peakme_export` | Output directory |
| `--width` | `400` | Image width in pixels |
| `--height` | `400` | Image height in pixels |
| `--colormap` | `viridis` | Color scale: `viridis`, `magma`, `plasma`, `inferno`, `cividis` |
| `--normalize` | `tic` | Normalization: `tic`, `rms`, `none` |
| `--zip` | off | Automatically zip the output folder |
| `--object-name` | auto | Object name in `.RData` file |

---

## 3. Output Format

The script produces:

```
peakme_export/
  metadata.csv          ← required by PeakMe
  798.5432.png          ← one PNG per m/z feature
  799.1201.png
  ...
```

**metadata.csv** format (two columns, required):

```csv
filename,mz_value
798.5432.png,798.5432
799.1201.png,799.1201
```

You can create or edit this file manually if you have PNGs from a different source — just ensure each row maps a filename to its m/z value.

---

## 4. Upload to PeakMe

1. If you used `--zip`, a `peakme_export.zip` file was created automatically.
2. If not, zip manually:
   ```bash
   zip -r peakme_export.zip peakme_export/
   ```
3. Go to your PeakMe project → **New Dataset** → upload the ZIP file.

---

## Tips

- **Large datasets (>10,000 ions):** The export script prints progress every 100 ions. A 10,000-ion dataset typically takes 5–15 minutes depending on image size.
- **Image resolution:** 400×400 px is the recommended default. Larger images (e.g., 800×800) produce nicer zoom quality but increase ZIP size and upload time.
- **Colormap choice:** `viridis` is perceptually uniform and colorblind-friendly. `magma` shows high-intensity regions with bright yellow/white, which some scientists prefer for sparse signals. Use the same colormap within a project for consistent comparison.
- **Normalization:** TIC (total ion current) normalization is standard for comparing ion distributions across a tissue section. Use `none` if you have already normalized in your Cardinal workflow.
- **Subsetting:** You can export only a subset of m/z values by pre-filtering your MSImagingExperiment in R before running the script:
  ```r
  msi_subset <- msi[mz(msi) > 700 & mz(msi) < 900, ]
  save(msi_subset, file = "subset_700_900.RData")
  ```
