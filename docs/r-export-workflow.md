# PeakMe R Workflow

This guide covers both directions of the PeakMe R workflow:
- **PeakMe Import:** render ion images in R and upload to PeakMe for annotation
- **PeakMe Export:** pull PeakMe annotations back into R and create a filtered experiment

---

## PeakMe Import (Cardinal → PeakMe)

### Overview

PeakMe does not process raw mass spectrometry files server-side. Instead, you render ion images locally using Cardinal, then upload a ZIP of PNGs to PeakMe.

**Steps:**
1. Install R dependencies
2. Run `peakme_import.R` on your data
3. Zip the output folder
4. Upload the ZIP to PeakMe and create a dataset

---

### 1. Install R Dependencies

In R or RStudio:

```r
if (!requireNamespace("BiocManager", quietly = TRUE))
  install.packages("BiocManager")

BiocManager::install("Cardinal")
install.packages(c("viridis", "optparse", "png"))
```

---

### 2. Run the PeakMe Import Script

Download `peakme_import.R` from the PeakMe instructions page (↓ PeakMe Import button).

#### Option A: RStudio (interactive)

If your MSImagingExperiment is already loaded in your R session:

1. Open `peakme_export.R` in RStudio
2. Edit the config block near the top:
   ```r
   msi_object = "mse_process"     # name of your variable — run ls() to check
   output     = "./peakme_upload"
   ```
3. Click **Source** (Ctrl+Shift+S on Windows · Cmd+Shift+S on Mac)

#### Option B: Command line — from a file

```bash
# From an imzML file
Rscript peakme_import.R \
  --file /path/to/your/data.imzML \
  --output ./peakme_upload \
  --normalize rms \
  --zip

# From a saved .RData / .rda file
Rscript peakme_import.R \
  --file my_experiment.RData \
  --output ./peakme_upload \
  --zip
```

#### All Options

| Option | Default | Description |
|---|---|---|
| `--file` | *(required)* | Path to `.imzML` or `.RData` file |
| `--output` | `./peakme_upload` | Output directory |
| `--width` | `720` | Image width in pixels |
| `--height` | `720` | Image height in pixels |
| `--colormap` | `viridis` | Color scale: `viridis`, `magma`, `plasma`, `inferno`, `cividis` |
| `--normalize` | `rms` | Normalization: `tic`, `rms`, `none` |
| `--zip` | off | Automatically zip the output folder |

---

### 3. Output Format

The script produces:

```
peakme_upload/
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

### 4. Upload to PeakMe

1. If you used `--zip`, a `peakme_upload.zip` file was created automatically.
2. If not, zip manually:
   ```bash
   # macOS / Linux
   zip -r peakme_upload.zip peakme_upload/

   # Windows (PowerShell)
   Compress-Archive peakme_upload peakme_upload.zip
   ```
3. Go to your PeakMe project → **New Dataset** → upload the ZIP file.

---

## PeakMe Export (PeakMe → R)

After annotating in PeakMe, use `peakme_export.R` to attach labels back to your `MSImagingExperiment` and create a filtered object for downstream analysis.

### 5. Export Annotations from PeakMe

1. Go to your project or dataset page in PeakMe
2. Click **Export CSV**
3. Save the file, e.g. `peakme_annotations.csv`

The CSV contains one row per annotated ion with columns: `mz_value`, `label_name`, `starred`, `confidence`, `annotator`, `annotated_at`, `updated_at`.

---

### 6. Run the PeakMe Export Script

Download `peakme_export.R` from the PeakMe instructions page (↓ PeakMe Export button).

**Dependency:** only `Cardinal` (already installed from the PeakMe Import step).

#### RStudio (interactive)

1. Make sure your `MSImagingExperiment` is loaded in the session (the same object you exported from)
2. Open `peakme_export.R` and edit the config block:
   ```r
   msi_object       = "mse_process"           # name of your MSE variable
   csv_file         = "peakme_annotations.csv" # path to the PeakMe CSV
   labels_to_remove = c("matrix", "noise")     # labels to strip for MSE_clean
   unannotated      = "keep"                   # "keep" (label = NA) or "remove"
   ```
3. Click **Source** (Ctrl+Shift+S / Cmd+Shift+S)

#### Config reference

| Setting | Default | Description |
|---|---|---|
| `msi_object` | `"mse_process"` | Name of your MSImagingExperiment variable in the R session |
| `csv_file` | `"peakme_annotations.csv"` | Path to the CSV exported from PeakMe |
| `multi_annotator` | `"last"` | When multiple annotators labelled the same ion: `"first"` or `"last"` (by timestamp) |
| `labels_to_remove` | `c("matrix", "noise")` | Labels to strip out when creating `MSE_clean` |
| `unannotated` | `"keep"` | What to do with ions not in the CSV: `"keep"` (label = NA) or `"remove"` |

---

### What the script produces

**Annotation columns added to `fData()`** of your existing MSE object:

```r
fData(mse_process)$peakme_label      # "liver", "kidney", NA (unannotated), …
fData(mse_process)$peakme_starred    # TRUE / FALSE / NA
fData(mse_process)$peakme_confidence # 1 (low) · 2 (medium) · 3 (high) · NA
fData(mse_process)$peakme_annotator  # annotator display name · NA
```

**`MSE_clean`** — a new MSImagingExperiment in your session with `labels_to_remove` features filtered out:

```r
# Example: 5,072 total → 655 noise/matrix removed → 4,417 features kept
MSE_clean  # use this for downstream analysis, dimensionality reduction, etc.
```

The script also prints a coverage summary and label breakdown to the Console.

---

## Tips

- **Large datasets:** The PeakMe Import script prints rate and ETA every 100 ions.
- **m/z matching:** The PeakMe Export script uses exact float matching. m/z values are bit-for-bit identical round-tripping through R → PostgreSQL → CSV → R. A nearest-neighbour fallback within 0.001 Da handles edge cases and warns you.
- **Multiple annotators:** `multi_annotator = "last"` keeps the most recently updated label per ion; `"first"` keeps whichever row appears first in the CSV.
- **Colormap:** `viridis` is perceptually uniform and colorblind-friendly. Use the same colormap within a project for consistent comparison.
- **Normalization:** RMS works well for most peak-picked experiments. Use `none` if you have already normalized in your Cardinal workflow.
- **Subsetting before export:**
  ```r
  msi_subset <- mse_process[mz(mse_process) > 700 & mz(mse_process) < 900, ]
  # then set msi_object = "msi_subset" in the export config
  ```
