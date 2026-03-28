# =============================================================================
# PeakMe: Cardinal MSI → PNG Export Script
# =============================================================================
# Exports each m/z feature in an MSImagingExperiment as a PNG image and writes
# a metadata.csv manifest. The output folder can be zipped and uploaded to
# PeakMe for annotation.
#
# Dependencies:
#   install.packages("BiocManager")
#   BiocManager::install("Cardinal")
#   install.packages(c("viridis", "optparse"))
#
# ── RStudio / interactive use (Windows or Mac) ───────────────────────────────
# 1. Edit the config block below (lines marked EDIT ME)
# 2. Click Source (or press Ctrl+Shift+S / Cmd+Shift+S)
#
# ── Command-line use ─────────────────────────────────────────────────────────
#   Rscript export_cardinal_pngs.R --input path/to/data.imzML --output ./peakme_export
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
    input        = "C:/path/to/your/data.imzML",  # EDIT ME — .imzML or .RData
    output       = "./peakme_export",              # EDIT ME — output folder
    width        = 400L,
    height       = 400L,
    colormap     = "viridis",   # viridis | magma | plasma | inferno | cividis
    normalize    = "rms",       # rms | tic | none
    zip          = TRUE,        # create a .zip ready for PeakMe upload?
    `object-name` = NULL        # RData only: object name, or NULL to auto-detect
  )
} else {
  # ---------------------------------------------------------------------------
  # CLI argument parsing (Rscript / terminal use)
  # ---------------------------------------------------------------------------
  option_list <- list(
    make_option(c("-i", "--input"),
      type = "character", default = NULL,
      help = "Path to .imzML file or .RData file containing an MSImagingExperiment object",
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
    ),
    make_option(c("--object-name"),
      type = "character", default = NULL,
      help = "Name of the MSImagingExperiment object in .RData file (auto-detected if omitted)"
    )
  )

  parser <- OptionParser(
    usage = "%prog [options]",
    option_list = option_list,
    description = "Export Cardinal MSI data to PNGs for PeakMe annotation"
  )
  args <- parse_args(parser)

  if (is.null(args$input)) {
    print_help(parser)
    stop("--input is required", call. = FALSE)
  }
}

# ---------------------------------------------------------------------------
# Load MSImagingExperiment
# ---------------------------------------------------------------------------
message("PeakMe export: loading data from ", args$input)

ext <- tolower(tools::file_ext(args$input))

if (ext == "imzml") {
  msi <- readMSIData(args$input)
} else if (ext %in% c("rdata", "rda")) {
  env <- new.env()
  load(args$input, envir = env)
  obj_names <- ls(env)

  if (!is.null(args[["object-name"]])) {
    obj_name <- args[["object-name"]]
  } else {
    # Auto-detect: find the first MSImagingExperiment
    msi_names <- obj_names[sapply(obj_names, function(n) {
      inherits(get(n, envir = env), "MSImagingExperiment")
    })]
    if (length(msi_names) == 0) {
      stop("No MSImagingExperiment found in .RData file. Use --object-name to specify.", call. = FALSE)
    }
    obj_name <- msi_names[1]
    message("  Auto-detected MSImagingExperiment object: ", obj_name)
  }
  msi <- get(obj_name, envir = env)
} else {
  stop("Unsupported file type: ", ext, ". Use .imzML or .RData", call. = FALSE)
}

message("  Loaded: ", ncol(msi), " pixels, ", length(mz(msi)), " m/z features")

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
# Create output directory (clean any previous run first)
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
# Export each m/z feature
# ---------------------------------------------------------------------------
mz_values <- mz(msi)
n_features <- length(mz_values)

message("  Exporting ", n_features, " ion images to ", args$output, "/")

metadata_rows <- vector("list", n_features)

for (i in seq_along(mz_values)) {
  mz_val  <- mz_values[i]
  fname   <- sprintf("%.4f.png", mz_val)
  fpath   <- file.path(args$output, fname)

  # Extract intensity matrix for this feature
  img_data <- iData(msi)[i, ]  # 1 x n_pixels vector

  # Reshape to 2D spatial grid
  coords   <- coord(msi)
  x_vals   <- coords$x
  y_vals   <- coords$y
  x_range  <- range(x_vals)
  y_range  <- range(y_vals)
  mat      <- matrix(NA_real_,
                     nrow = diff(y_range) + 1,
                     ncol = diff(x_range) + 1)
  for (px in seq_along(img_data)) {
    xi <- x_vals[px] - x_range[1] + 1
    yi <- y_vals[px] - y_range[1] + 1
    mat[yi, xi] <- img_data[px]
  }

  # Normalize to [0, 1] for colormap
  mat_min <- min(mat, na.rm = TRUE)
  mat_max <- max(mat, na.rm = TRUE)
  if (mat_max > mat_min) {
    mat_norm <- (mat - mat_min) / (mat_max - mat_min)
  } else {
    mat_norm <- matrix(0, nrow = nrow(mat), ncol = ncol(mat))
  }

  # Write PNG
  png(fpath, width = args$width, height = args$height, bg = "black")
  par(mar = c(0, 0, 0, 0), oma = c(0, 0, 0, 0))
  image(t(mat_norm[nrow(mat_norm):1, ]),  # flip y-axis to match display convention
        col = colors, axes = FALSE, xlab = "", ylab = "",
        zlim = c(0, 1), asp = 1)
  dev.off()

  metadata_rows[[i]] <- data.frame(
    filename = fname,
    mz_value = mz_val,
    stringsAsFactors = FALSE
  )

  if (i %% 100 == 0 || i == n_features) {
    message(sprintf("  Progress: %d / %d (%.0f%%)", i, n_features, 100 * i / n_features))
  }
}

# ---------------------------------------------------------------------------
# Write metadata.csv
# ---------------------------------------------------------------------------
metadata <- do.call(rbind, metadata_rows)
metadata_path <- file.path(args$output, "metadata.csv")
write.csv(metadata, metadata_path, row.names = FALSE)
message("  Wrote metadata.csv with ", nrow(metadata), " rows")

# ---------------------------------------------------------------------------
# Optional zip
# ---------------------------------------------------------------------------
if (args$zip) {
  zip_path <- paste0(args$output, ".zip")
  message("  Creating zip: ", zip_path)
  zip(zip_path, files = args$output, flags = "-r9q")
  message("  Done. Upload ", zip_path, " to PeakMe.")
} else {
  message("  Done. Zip the '", basename(args$output), "/' folder and upload to PeakMe.")
  message("  Quick zip command:")
  message("    cd ", dirname(normalizePath(args$output)),
          " && zip -r ", basename(args$output), ".zip ", basename(args$output), "/")
}
