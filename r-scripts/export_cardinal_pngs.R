#!/usr/bin/env Rscript
# =============================================================================
# PeakMe: Cardinal MSI → PNG Export Script
# =============================================================================
# Exports each m/z feature in an MSImagingExperiment as a PNG image and writes
# a metadata.csv manifest. The output folder can be zipped and uploaded to
# PeakMe for annotation.
#
# The script accepts an MSImagingExperiment from any source:
#   - already loaded in your R session (peak-picked, aligned, filtered, raw…)
#   - read from an .imzML file
#   - loaded from a saved .RData / .rda file
#
# Dependencies:
#   install.packages("BiocManager")
#   BiocManager::install("Cardinal")
#   install.packages(c("viridis", "optparse"))
#
# ── RStudio / interactive use ─────────────────────────────────────────────────
# 1. Edit the config block below (lines marked EDIT ME)
# 2. Click Source  (Ctrl+Shift+S on Windows · Cmd+Shift+S on Mac)
#
# ── Command-line use ─────────────────────────────────────────────────────────
#   # From an object name in a running R session — not applicable on CLI
#   # From a file:
#   Rscript export_cardinal_pngs.R --file path/to/data.imzML --output ./peakme_export
#   Rscript export_cardinal_pngs.R --file path/to/experiment.RData --output ./peakme_export
#
# See docs/r-export-workflow.md for full instructions.
# =============================================================================

suppressPackageStartupMessages({
  library(Cardinal)
  library(viridis)
  library(optparse)
  library(grDevices)
})

# ---------------------------------------------------------------------------
# Config — edit this block when running inside RStudio
# (ignored when called from the command line via Rscript)
# ---------------------------------------------------------------------------
if (interactive()) {
  args <- list(
    # ── Where is your MSImagingExperiment? Set ONE of the two options below ──

    # Option A: name of a variable already loaded in your R session
    #   (works for raw read-ins, peak-picked, aligned, filtered — anything)
    msi_object = "msi",   # EDIT ME — run ls() to see your variable names
                           #           set to NULL to use Option B instead

    # Option B: path to a file to load from (imzML or RData)
    #   (used only when msi_object is NULL)
    msi_file   = NULL,    # EDIT ME — e.g. "C:/data/sample.imzML"
                           #                  "C:/data/experiment.RData"

    # ── Output settings ──────────────────────────────────────────────────────
    output    = "./peakme_export",  # EDIT ME — folder to write PNGs into
    width     = 400L,
    height    = 400L,
    colormap  = "viridis",  # viridis | magma | plasma | inferno | cividis
    normalize = "rms",      # rms | tic | none
    zip       = TRUE        # TRUE = create a .zip ready to upload to PeakMe
  )
} else {
  # ---------------------------------------------------------------------------
  # CLI argument parsing (Rscript / terminal use)
  # ---------------------------------------------------------------------------
  option_list <- list(
    make_option(c("-f", "--file"),
      type = "character", default = NULL,
      help = "Path to .imzML or .RData file containing an MSImagingExperiment",
      metavar = "FILE"
    ),
    make_option(c("-o", "--output"),
      type = "character", default = "./peakme_export",
      help = "Output directory for PNGs and metadata.csv [default: ./peakme_export]",
      metavar = "DIR"
    ),
    make_option(c("--width"),
      type = "integer", default = 400,
      help = "Image width in pixels [default: 400]"
    ),
    make_option(c("--height"),
      type = "integer", default = 400,
      help = "Image height in pixels [default: 400]"
    ),
    make_option(c("--colormap"),
      type = "character", default = "viridis",
      help = "Colormap: viridis, magma, plasma, inferno, cividis [default: viridis]"
    ),
    make_option(c("--normalize"),
      type = "character", default = "rms",
      help = "Intensity normalization: tic, rms, none [default: rms]"
    ),
    make_option(c("--zip"),
      action = "store_true", default = FALSE,
      help = "Zip the output directory after export (produces <output>.zip)"
    )
  )

  parser <- OptionParser(
    usage = "%prog [options]",
    option_list = option_list,
    description = "Export a Cardinal MSImagingExperiment to PNGs for PeakMe annotation"
  )
  args <- parse_args(parser)
  args$msi_object <- NULL
  args$msi_file   <- args$file

  if (is.null(args$msi_file)) {
    print_help(parser)
    stop("--file is required", call. = FALSE)
  }
}

# ---------------------------------------------------------------------------
# Load / locate the MSImagingExperiment
# ---------------------------------------------------------------------------
if (!is.null(args$msi_object)) {
  # ── Option A: object already in the R session ──
  if (!exists(args$msi_object, envir = .GlobalEnv)) {
    stop(
      "Object '", args$msi_object, "' not found in your R session.\n",
      "  Run ls() to see available variables, or set msi_file to load from a file.",
      call. = FALSE
    )
  }
  msi <- get(args$msi_object, envir = .GlobalEnv)
  message("PeakMe export: using object '", args$msi_object, "' from R session")

} else if (!is.null(args$msi_file)) {
  # ── Option B: load from a file ──
  message("PeakMe export: loading from ", args$msi_file)
  ext <- tolower(tools::file_ext(args$msi_file))

  if (ext == "imzml") {
    msi <- readMSIData(args$msi_file)

  } else if (ext %in% c("rdata", "rda")) {
    env <- new.env()
    load(args$msi_file, envir = env)

    # Find MSImagingExperiment objects in the file
    msi_names <- Filter(
      function(n) inherits(get(n, envir = env), "MSImagingExperiment"),
      ls(env)
    )
    if (length(msi_names) == 0) {
      stop(
        "No MSImagingExperiment found in ", args$msi_file, ".\n",
        "  Objects present: ", paste(ls(env), collapse = ", "),
        call. = FALSE
      )
    }
    if (length(msi_names) > 1) {
      message("  Found multiple MSImagingExperiment objects: ", paste(msi_names, collapse = ", "))
      message("  Using the first: '", msi_names[1], "'")
      message("  To use a different one, set msi_object = \"", msi_names[2], "\" instead.")
    }
    msi <- get(msi_names[1], envir = env)
    message("  Loaded: '", msi_names[1], "'")

  } else {
    stop("Unsupported file type '.", ext, "' — use .imzML or .RData", call. = FALSE)
  }

} else {
  stop(
    "Nothing to load.\n",
    "  In RStudio: set msi_object (variable name) or msi_file (file path) in the config block.\n",
    "  On CLI: use --file path/to/data.imzML",
    call. = FALSE
  )
}

# Verify we actually have an MSImagingExperiment
if (!inherits(msi, "MSImagingExperiment")) {
  stop(
    "Expected an MSImagingExperiment but got: ", class(msi)[1], ".\n",
    "  Make sure the object is a Cardinal MSImagingExperiment.",
    call. = FALSE
  )
}

message("  Dimensions: ", ncol(msi), " pixels · ", length(mz(msi)), " m/z features")

# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------
if (args$normalize != "none") {
  message("  Normalizing: ", args$normalize)
  msi <- normalize(msi, method = args$normalize)
}

# ---------------------------------------------------------------------------
# Colormap setup
# ---------------------------------------------------------------------------
cmap_fn <- switch(args$colormap,
  "viridis"  = viridis,
  "magma"    = magma,
  "plasma"   = plasma,
  "inferno"  = inferno,
  "cividis"  = cividis,
  stop("Unknown colormap: ", args$colormap, call. = FALSE)
)
colors <- cmap_fn(256)

# ---------------------------------------------------------------------------
# Create output directory (clean previous PNGs/CSVs if re-running)
# ---------------------------------------------------------------------------
if (dir.exists(args$output)) {
  old_files <- list.files(args$output, pattern = "\\.png$|\\.csv$", full.names = TRUE)
  if (length(old_files) > 0) {
    message("  Cleaning ", length(old_files), " files from previous run in ", args$output, "/")
    file.remove(old_files)
  }
}
dir.create(args$output, recursive = TRUE, showWarnings = FALSE)

# ---------------------------------------------------------------------------
# Export each m/z feature as a PNG
# ---------------------------------------------------------------------------
mz_values  <- mz(msi)
n_features <- length(mz_values)

message("  Exporting ", n_features, " ion images to ", args$output, "/")

# ── Pre-compute pixel → matrix index mapping ONCE (avoids recomputing per feature) ──
coords  <- coord(msi)
x_vals  <- coords$x
y_vals  <- coords$y
x_min   <- min(x_vals); y_min <- min(y_vals)
n_rows  <- max(y_vals) - y_min + 1L
n_cols  <- max(x_vals) - x_min + 1L
xi_idx  <- x_vals - x_min + 1L
yi_idx  <- y_vals - y_min + 1L
mat_idx <- cbind(yi_idx, xi_idx)   # matrix subscript for vectorised fill

# ── Materialise all intensities up-front if memory allows ────────────────────
# iData() may be a memory-mapped matter_mat; row-by-row access re-reads disk
# and re-applies any lazy normalisation for *each* feature — very slow.
# Pulling it all into a plain matrix costs RAM but makes the loop 20-100× faster.
gb_needed <- (n_features * ncol(msi) * 8) / 1e9
message(sprintf("  Intensity matrix: %.1f GB needed", gb_needed))
if (gb_needed < 4) {
  message("  Materialising intensity matrix (this may take a moment)…")
  int_mat <- as.matrix(iData(msi))   # features × pixels, plain R matrix
  get_row <- function(i) int_mat[i, ]
} else {
  message("  Dataset too large to materialise; reading row-by-row (slower).")
  get_row <- function(i) as.numeric(iData(msi)[i, ])
}

metadata_rows <- vector("list", n_features)
t_start <- proc.time()[["elapsed"]]

for (i in seq_along(mz_values)) {
  mz_val   <- mz_values[i]
  fname    <- sprintf("%.4f.png", mz_val)
  fpath    <- file.path(args$output, fname)

  img_data <- get_row(i)

  # Vectorised fill — replaces the 100k-iteration R for-loop
  mat <- matrix(NA_real_, nrow = n_rows, ncol = n_cols)
  mat[mat_idx] <- img_data

  mat_min <- min(mat, na.rm = TRUE)
  mat_max <- max(mat, na.rm = TRUE)
  if (mat_max > mat_min) {
    mat_norm <- (mat - mat_min) / (mat_max - mat_min)
  } else {
    mat_norm <- matrix(0, nrow = n_rows, ncol = n_cols)
  }

  png(fpath, width = args$width, height = args$height, bg = "black")
  par(mar = c(0, 0, 0, 0), oma = c(0, 0, 0, 0))
  image(t(mat_norm[n_rows:1, ]),
        col = colors, axes = FALSE, xlab = "", ylab = "",
        zlim = c(0, 1), asp = 1)
  dev.off()

  metadata_rows[[i]] <- data.frame(filename = fname, mz_value = mz_val,
                                   stringsAsFactors = FALSE)

  if (i %% 100 == 0 || i == n_features) {
    elapsed  <- proc.time()[["elapsed"]] - t_start
    rate     <- i / elapsed
    eta_min  <- (n_features - i) / rate / 60
    message(sprintf("  Progress: %d / %d (%.0f%%) — %.1f img/s — ETA %.0f min",
                    i, n_features, 100 * i / n_features, rate, eta_min))
  }
}

# ---------------------------------------------------------------------------
# Write metadata.csv
# ---------------------------------------------------------------------------
metadata      <- do.call(rbind, metadata_rows)
metadata_path <- file.path(args$output, "metadata.csv")
write.csv(metadata, metadata_path, row.names = FALSE)
message("  Wrote metadata.csv (", nrow(metadata), " ions)")

# ---------------------------------------------------------------------------
# Optional zip
# ---------------------------------------------------------------------------
if (args$zip) {
  zip_path <- paste0(args$output, ".zip")
  message("  Creating zip: ", zip_path)
  zip(zip_path, files = args$output, flags = "-r9q")
  message("  Done. Upload '", basename(zip_path), "' to PeakMe.")
} else {
  message("  Done. Zip the '", basename(args$output), "/' folder and upload to PeakMe.")
  message("  Quick zip command:")
  message("    cd ", dirname(normalizePath(args$output)),
          " && zip -r ", basename(args$output), ".zip ", basename(args$output), "/")
}
