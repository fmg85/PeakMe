#!/usr/bin/env Rscript
# =============================================================================
# PeakMe: Cardinal MSI → PNG Export Script  [version 1.3.2 · 2026-03-30]
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
#   install.packages(c("viridis", "optparse", "png"))
#
# ── RStudio / interactive use ─────────────────────────────────────────────────
# 1. Edit the config block below (lines marked EDIT ME)
# 2. Click Source  (Ctrl+Shift+S on Windows · Cmd+Shift+S on Mac)
#
# ── Command-line use ─────────────────────────────────────────────────────────
#   # From an object name in a running R session — not applicable on CLI
#   # From a file:
#   Rscript peakme_import.R --file path/to/data.imzML --output ./peakme_upload
#   Rscript peakme_import.R --file path/to/experiment.RData --output ./peakme_upload
#
# See docs/r-export-workflow.md for full instructions.
# =============================================================================

suppressPackageStartupMessages({
  library(Cardinal)
  library(viridis)
  library(optparse)
  library(grDevices)
  library(png)
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
    msi_object = "mse_process",   # EDIT ME — run ls() to see your variable names
                           #           set to NULL to use Option B instead

    # Option B: path to a file to load from (imzML or RData)
    #   (used only when msi_object is NULL)
    msi_file   = NULL,    # EDIT ME — e.g. "C:/data/sample.imzML"
                           #                  "C:/data/experiment.RData"

    # ── Output settings ──────────────────────────────────────────────────────
    output    = "./peakme_upload",  # EDIT ME — folder to write PNGs into
    width     = 720L,
    height    = 720L,
    colormap   = "viridis",  # viridis | magma | plasma | inferno | cividis
    normalize  = "rms",      # rms | tic | none
    zip        = TRUE,       # TRUE = create a .zip ready to upload to PeakMe
    export_tic = TRUE,       # TRUE = generate a TIC spectrum PNG per ion image
                             # (adds time to export; included in the ZIP)
    tic_window = 1.0,        # ± Da window around each ion's m/z in TIC plot
    tic_labels = 5L          # number of highest peaks to label with their m/z
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
      type = "character", default = "./peakme_upload",
      help = "Output directory for PNGs and metadata.csv [default: ./peakme_upload]",
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
    ),
    make_option("--no-tic",
      action = "store_true", default = FALSE,
      help = "Skip TIC spectrum PNG generation (faster export, smaller ZIP)"
    ),
    make_option("--tic-window",
      type = "double", default = 1.0,
      help = "±Da window around each ion's m/z shown in TIC plot [default: 1.0]"
    ),
    make_option("--tic-labels",
      type = "integer", default = 5L,
      help = "Number of highest peaks to label with m/z in TIC plot [default: 5]"
    )
  )

  parser <- OptionParser(
    usage = "%prog [options]",
    option_list = option_list,
    description = "Export a Cardinal MSImagingExperiment to PNGs for PeakMe annotation"
  )
  args <- parse_args(parser)
  args$msi_object <- NULL
  args$export_tic <- !args[["no-tic"]]
  args$tic_window <- args[["tic-window"]]
  args$tic_labels <- args[["tic-labels"]]
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
      "Object '", args$msi_object, "' not found in your R session. ",
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
        "No MSImagingExperiment found in ", args$msi_file, ". ",
        "  Objects present: ", paste(ls(env), collapse = ", "),
        call. = FALSE
      )
    }
    if (length(msi_names) > 1) {
      message("  Found multiple MSImagingExperiment objects: ", paste(msi_names, collapse = ", "))
      message("  Using the first: '", msi_names[1], "'")
      message("  To use a different one, set msi_object = '", msi_names[2], "' instead.")
    }
    msi <- get(msi_names[1], envir = env)
    message("  Loaded: '", msi_names[1], "'")

  } else {
    stop("Unsupported file type '.", ext, "' — use .imzML or .RData", call. = FALSE)
  }

} else {
  stop(
    "Nothing to load. ",
    "In RStudio: set msi_object (variable name) or msi_file (file path) in the config block. ",
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

# ── Pre-compute pixel → matrix index mapping ONCE ────────────────────────────
coords  <- coord(msi)
x_vals  <- coords$x
y_vals  <- coords$y
x_min   <- min(x_vals); y_min <- min(y_vals)
n_rows  <- max(y_vals) - y_min + 1L
n_cols  <- max(x_vals) - x_min + 1L
xi_idx  <- x_vals - x_min + 1L
yi_idx  <- y_vals - y_min + 1L
mat_idx <- cbind(yi_idx, xi_idx)

# ── Materialise all intensities up-front if memory allows ────────────────────
# Cardinal may store iData() as a memory-mapped matter_mat; row-by-row access
# re-reads disk and re-applies any lazy normalisation for every feature.
# Estimate bytes assuming float32 (Cardinal's default storage type).
bytes_per_val <- if (is.double(iData(msi)[1L, 1L])) 8 else 4
gb_needed <- (n_features * ncol(msi) * bytes_per_val) / 1e9
message(sprintf("  Intensity matrix: ~%.1f GB needed", gb_needed))
if (gb_needed < 8) {
  message("  Materialising intensity matrix (this may take a moment)…")
  int_mat <- as.matrix(iData(msi))   # features × pixels, plain R matrix
  get_row <- function(i) int_mat[i, ]
} else {
  message("  Dataset too large to materialise; reading row-by-row.")
  get_row <- function(i) as.numeric(iData(msi)[i, ])
}

# ── Pre-compute colormap as float RGB (256 × 3) for direct pixel writes ──────
colors_rgb <- t(col2rgb(colors)) / 255   # 256 × 3, values in [0, 1]

# ── Pre-compute mean spectrum for TIC plots (once, reused per ion) ────────────
if (args$export_tic) {
  if (exists("int_mat")) {
    message("  Pre-computing mean spectrum for TIC plots…")
    mean_spec <- rowMeans(int_mat, na.rm = TRUE)
  } else {
    message("  Note: TIC spectrum export skipped — dataset too large to materialise.")
    args$export_tic <- FALSE
  }
}

# ── TIC spectrum renderer ─────────────────────────────────────────────────────
# Renders the mean mass spectrum in a ±window_da window around the target m/z.
# Uses a png() graphics device so axes, labels, and peak annotations render
# correctly. Writes directly to out_path.
render_tic_png <- function(feat_idx, mz_values, mean_spec, out_path, w, h,
                           window_da = 1.0, n_label = 5L) {
  target_mz <- mz_values[feat_idx]
  lo <- target_mz - window_da
  hi <- target_mz + window_da
  mask  <- mz_values >= lo & mz_values <= hi
  mz_w  <- mz_values[mask]
  int_w <- mean_spec[mask]

  # Dark theme colours
  col_bg  <- "#0f172a"
  col_bar <- "#a78bfa"   # purple bars
  col_mkr <- "#f97316"   # orange target marker
  col_ax  <- "#64748b"   # axis lines / ticks
  col_txt <- "#94a3b8"   # axis tick labels
  col_lbl <- "#e2e8f0"   # peak m/z labels

  grDevices::png(out_path, width = w, height = h, bg = col_bg)
  on.exit(grDevices::dev.off(), add = TRUE)

  if (length(mz_w) < 2L) {
    graphics::plot.new()
    return(invisible(NULL))
  }

  int_max <- max(int_w, na.rm = TRUE)
  if (is.na(int_max) || int_max <= 0) int_max <- 1
  y_top <- int_max * 1.25   # headroom for peak labels

  op <- graphics::par(
    bg      = col_bg,
    col     = col_bar,
    col.lab = col_txt,
    col.axis= col_txt,
    fg      = col_ax,
    mar     = c(4.5, 5.0, 1.5, 1.5),
    tcl     = -0.3,
    mgp     = c(3, 0.5, 0),
    family  = "sans"
  )
  on.exit(graphics::par(op), add = TRUE)

  graphics::plot(
    mz_w, int_w,
    type = "h", lwd = 2, col = col_bar,
    xlim = c(lo, hi), ylim = c(0, y_top),
    xlab = "", ylab = "",
    axes = FALSE
  )

  # Axes
  graphics::axis(1, col = col_ax, col.ticks = col_ax, col.axis = col_txt, cex.axis = 0.72)
  y_ticks <- graphics::axTicks(2)
  graphics::axis(2, at = y_ticks, col = col_ax, col.ticks = col_ax, col.axis = col_txt,
                 cex.axis = 0.72, las = 1,
                 labels = format(y_ticks, scientific = TRUE, digits = 2))
  graphics::title(xlab = "m/z",                  col.lab = col_txt, cex.lab = 0.85, line = 2.8)
  graphics::title(ylab = "Total Ion Intensity",   col.lab = col_txt, cex.lab = 0.85, line = 3.8)

  # Orange vertical marker at the target m/z
  graphics::abline(v = target_mz, col = col_mkr, lwd = 1.5, lty = 1)

  # Label top-N peaks by intensity
  n_top   <- min(n_label, length(mz_w))
  top_idx <- order(int_w, decreasing = TRUE)[seq_len(n_top)]
  graphics::text(
    x      = mz_w[top_idx],
    y      = int_w[top_idx],
    labels = sprintf("%.4f", mz_w[top_idx]),
    col    = col_lbl,
    cex    = 0.58,
    pos    = 3,       # above the bar tip
    offset = 0.25
  )

  invisible(NULL)
}

metadata_rows <- vector("list", n_features)
t_start <- proc.time()[["elapsed"]]

for (i in seq_along(mz_values)) {
  mz_val   <- mz_values[i]
  fname    <- sprintf("%.4f.png", mz_val)
  fpath    <- file.path(args$output, fname)

  img_data <- get_row(i)

  # Vectorised fill
  mat <- matrix(NA_real_, nrow = n_rows, ncol = n_cols)
  mat[mat_idx] <- img_data

  # Normalise to [0, 1]
  mat_min <- min(mat, na.rm = TRUE)
  mat_max <- max(mat, na.rm = TRUE)
  if (mat_max > mat_min) {
    mat_norm <- (mat - mat_min) / (mat_max - mat_min)
  } else {
    mat_norm <- matrix(0.0, nrow = n_rows, ncol = n_cols)
  }

  # Map each pixel to a colormap index (1..256), NA → black (index 1)
  cidx <- pmax(1L, pmin(256L, as.integer(mat_norm * 255.0) + 1L))
  cidx[is.na(cidx)] <- 1L

  # Build height × width × 3 float array and write PNG directly
  # (avoids opening/closing an R graphics device for every feature)
  img_arr <- array(
    c(colors_rgb[cidx, 1L], colors_rgb[cidx, 2L], colors_rgb[cidx, 3L]),
    dim = c(n_rows, n_cols, 3L)
  )
  writePNG(img_arr, fpath)

  # TIC spectrum PNG (same name with _tic suffix, landscape aspect ratio)
  if (args$export_tic) {
    tic_h    <- max(120L, args$width %/% 2L)
    tic_path <- file.path(args$output, sprintf("%.4f_tic.png", mz_val))
    render_tic_png(i, mz_values, mean_spec, tic_path,
                   args$width, tic_h, args$tic_window, args$tic_labels)
  }

  metadata_rows[[i]] <- data.frame(filename = fname, mz_value = mz_val,
                                   stringsAsFactors = FALSE)

  if (i %% 100L == 0L || i == n_features) {
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
