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
install.packages(c("viridis", "optparse", "png"))
```

---

## 2. Run the Export Script

Download `export_cardinal_pngs.R` from the PeakMe instructions page.

### Option A: RStudio (interactive)

If your MSImagingExperiment is already loaded in your R session (raw, peak-picked, aligned — anything):

1. Open `export_cardinal_pngs.R` in RStudio
2. Edit the config block near the top:
   ```r
   msi_object = "msi"          # name of your variable — run ls() to check
   output     = "./peakme_export"
   ```
3. Click **Source** (Ctrl+Shift+S on Windows · Cmd+Shift+S on Mac)

### Option B: Command line — from a file

```bash
# From an imzML file
Rscript export_cardinal_pngs.R \
  --file /path/to/your/data.imzML \
  --output ./peakme_export \
  --normalize rms \
  --zip

# From a saved .RData / .rda file
Rscript export_cardinal_pngs.R \
  --file my_experiment.RData \
  --output ./peakme_export \
  --zip
```

### All Options

| Option | Default | Description |
|---|---|---|
| `--file` | *(required)* | Path to `.imzML` or `.RData` file |
| `--output` | `./peakme_export` | Output directory |
| `--colormap` | `viridis` | Color scale: `viridis`, `magma`, `plasma`, `inferno`, `cividis` |
| `--normalize` | `rms` | Normalization: `tic`, `rms`, `none` |
| `--zip` | off | Automatically zip the output folder |

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

---

## 4. Upload to PeakMe

1. If you used `--zip`, a `peakme_export.zip` file was created automatically.
2. If not, zip manually:
   ```bash
   # macOS / Linux
   zip -r peakme_export.zip peakme_export/

   # Windows (PowerShell)
   Compress-Archive peakme_export peakme_export.zip
   ```
3. Go to your PeakMe project → **New Dataset** → upload the ZIP file.

---

## Tips

- **Progress / ETA:** The script prints rate and estimated time remaining every 100 ions.
- **Colormap choice:** `viridis` is perceptually uniform and colorblind-friendly. `magma` shows high-intensity regions with bright yellow/white, which some scientists prefer for sparse signals. Use the same colormap within a project for consistent comparison.
- **Normalization:** RMS normalization works well for most peak-picked experiments. Use `none` if you have already normalized in your Cardinal workflow.
- **Subsetting:** Export only a subset of m/z values by pre-filtering in R before running the script:
  ```r
  msi_subset <- msi[mz(msi) > 700 & mz(msi) < 900, ]
  # then set msi_object = "msi_subset" in the config block
  ```
