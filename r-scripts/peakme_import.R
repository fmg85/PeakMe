#!/usr/bin/env Rscript
# =============================================================================
# PeakMe: Annotation Import Script
# =============================================================================
# Attaches PeakMe annotations back to your MSImagingExperiment.
#
# What this script does:
#   1. Reads the CSV you exported from PeakMe
#   2. Matches each annotation to the correct m/z feature in your MSE object
#   3. Adds annotation columns to fData(): peakme_label, peakme_starred,
#      peakme_confidence, peakme_annotator
#   4. Optionally creates MSE_clean — the experiment with unwanted features
#      (noise, matrix, etc.) removed
#
# Dependencies:
#   BiocManager::install("Cardinal")
#
# ── RStudio / interactive use ─────────────────────────────────────────────────
# 1. Edit the config block below (lines marked EDIT ME)
# 2. Click Source  (Ctrl+Shift+S on Windows · Cmd+Shift+S on Mac)
#
# ── Command-line use ─────────────────────────────────────────────────────────
#   Rscript peakme_import.R --csv annotations.csv --output MSE_annotated.RData
# =============================================================================

suppressPackageStartupMessages({
  library(Cardinal)
})

# ---------------------------------------------------------------------------
# Config — edit this block when running inside RStudio
# (ignored when called from the command line via Rscript)
# ---------------------------------------------------------------------------
if (interactive()) {
  cfg <- list(
    # ── Your MSImagingExperiment ──────────────────────────────────────────────
    msi_object = "MSE_process",  # EDIT ME — name of the variable in your session
                                 # The same object you exported from

    # ── PeakMe annotation CSV ─────────────────────────────────────────────────
    csv_file = "peakme_annotations.csv",  # EDIT ME — path to the CSV from PeakMe

    # ── Multi-annotator handling ──────────────────────────────────────────────
    # If multiple people annotated the same ion, which one wins?
    # "first"  — keep whichever row appears first in the CSV
    # "last"   — keep the most recent (by annotated_at column)
    multi_annotator = "last",

    # ── Filtering for MSE_clean ───────────────────────────────────────────────
    # Labels to REMOVE from the clean object (noise, artefacts, etc.)
    # Set to character(0) to skip filtering and not create MSE_clean.
    labels_to_remove = c("matrix", "noise"),  # EDIT ME

    # How to handle ions with NO annotation in the CSV:
    # "keep"   — unannotated ions stay in MSE_clean (label = NA)
    # "remove" — unannotated ions are dropped from MSE_clean
    unannotated = "keep"  # EDIT ME
  )
} else {
  # ---------------------------------------------------------------------------
  # CLI argument parsing
  # ---------------------------------------------------------------------------
  suppressPackageStartupMessages(library(optparse))

  option_list <- list(
    make_option(c("-c", "--csv"),
      type = "character", default = NULL,
      help = "Path to PeakMe annotations CSV (required)",
      metavar = "FILE"
    ),
    make_option(c("-o", "--output"),
      type = "character", default = NULL,
      help = "Path to save annotated MSE object as .RData (optional)",
      metavar = "FILE"
    ),
    make_option(c("--object"),
      type = "character", default = "MSE_process",
      help = "Name of MSImagingExperiment variable in --rdata file [default: MSE_process]"
    ),
    make_option(c("--rdata"),
      type = "character", default = NULL,
      help = "Path to .RData file containing the MSImagingExperiment (optional if already loaded)"
    ),
    make_option(c("--remove"),
      type = "character", default = "matrix,noise",
      help = "Comma-separated labels to remove for MSE_clean [default: matrix,noise]"
    ),
    make_option(c("--unannotated"),
      type = "character", default = "keep",
      help = "What to do with unannotated ions in MSE_clean: keep or remove [default: keep]"
    ),
    make_option(c("--multi-annotator"),
      type = "character", default = "last",
      help = "Which annotation wins when multiple annotators: first or last [default: last]"
    )
  )

  parser <- OptionParser(
    usage = "%prog [options]",
    option_list = option_list,
    description = paste(
      "Attach PeakMe annotations to an MSImagingExperiment.",
      "Run from an R session that already has your MSE object loaded, or",
      "pass --rdata to load it from a file."
    )
  )
  args <- parse_args(parser)

  if (is.null(args$csv)) {
    print_help(parser)
    stop("--csv is required", call. = FALSE)
  }

  cfg <- list(
    msi_object      = args$object,
    csv_file        = args$csv,
    multi_annotator = args[["multi-annotator"]],
    labels_to_remove = if (nchar(args$remove) > 0)
                         trimws(strsplit(args$remove, ",")[[1]])
                       else character(0),
    unannotated     = args$unannotated
  )

  # Load MSE from file if --rdata was provided
  if (!is.null(args$rdata)) {
    message("PeakMe import: loading MSE from ", args$rdata)
    load(args$rdata, envir = .GlobalEnv)
  }
}

# =============================================================================
# 1. Load the MSImagingExperiment
# =============================================================================
if (!exists(cfg$msi_object, envir = .GlobalEnv)) {
  stop(
    "Object '", cfg$msi_object, "' not found in your R session.\n",
    "  - Run ls() to see what's loaded.\n",
    "  - Update msi_object in the config block.\n",
    "  - Or use --rdata on the command line to load from a file.",
    call. = FALSE
  )
}
mse <- get(cfg$msi_object, envir = .GlobalEnv)

if (!is(mse, "MSImagingExperiment")) {
  stop(
    "'", cfg$msi_object, "' is a ", class(mse), ", not an MSImagingExperiment.\n",
    "  Update msi_object to the correct variable name.",
    call. = FALSE
  )
}

n_features <- nrow(mse)
mz_values  <- mz(mse)
message("PeakMe import: MSE has ", n_features, " features, ",
        ncol(mse), " pixels")

# =============================================================================
# 2. Read the PeakMe CSV
# =============================================================================
if (!file.exists(cfg$csv_file)) {
  stop("CSV not found: ", cfg$csv_file, call. = FALSE)
}
ann <- read.csv(cfg$csv_file, stringsAsFactors = FALSE)

required_cols <- c("mz_value", "label_name")
missing_cols  <- setdiff(required_cols, colnames(ann))
if (length(missing_cols) > 0) {
  stop("CSV is missing required columns: ", paste(missing_cols, collapse = ", "),
       call. = FALSE)
}

message("PeakMe import: read ", nrow(ann), " annotation rows from ", cfg$csv_file)
if ("annotated_at" %in% colnames(ann)) {
  ann$annotated_at <- as.POSIXct(ann$annotated_at, format = "%Y-%m-%dT%H:%M:%S",
                                 tz = "UTC")
}

# ---------------------------------------------------------------------------
# 2a. Handle multiple annotators — collapse to one row per ion
# ---------------------------------------------------------------------------
n_annotators <- if ("annotator" %in% colnames(ann)) length(unique(ann$annotator)) else 1L

if (n_annotators > 1L) {
  message("PeakMe import: ", n_annotators, " annotators found. ",
          "Using '", cfg$multi_annotator, "' strategy.")

  if (cfg$multi_annotator == "last" && "annotated_at" %in% colnames(ann)) {
    # Sort descending so the most-recent row is first; then keep first per mz_value
    ann <- ann[order(ann$mz_value, ann$annotated_at, decreasing = c(FALSE, TRUE),
                     method = "radix"), ]
  }
  # Keep first occurrence of each mz_value (works for both "first" and "last")
  ann <- ann[!duplicated(ann$mz_value), ]
  message("PeakMe import: collapsed to ", nrow(ann), " unique ions")
}

# =============================================================================
# 3. Match annotations to features by m/z
# =============================================================================
# Strategy: exact match first (R double → float8 → CSV → R double is
# bit-for-bit identical for values that came from the same export). Fall back
# to nearest-neighbour within 0.001 Da and warn loudly.

ann_mz <- ann$mz_value

# Build index: for each annotation row, which MSE feature index does it map to?
feat_idx <- integer(nrow(ann))

for (i in seq_along(ann_mz)) {
  exact <- which(mz_values == ann_mz[i])
  if (length(exact) == 1L) {
    feat_idx[i] <- exact
  } else if (length(exact) > 1L) {
    warning("m/z ", ann_mz[i], " matches multiple features (", length(exact),
            " hits). Using the first.", call. = FALSE)
    feat_idx[i] <- exact[1L]
  } else {
    # Nearest-neighbour fallback
    diffs <- abs(mz_values - ann_mz[i])
    nn    <- which.min(diffs)
    if (diffs[nn] <= 0.001) {
      warning("m/z ", ann_mz[i], " had no exact match; using nearest feature at ",
              round(mz_values[nn], 6), " (Δ = ", round(diffs[nn] * 1000, 3), " mDa).",
              call. = FALSE)
      feat_idx[i] <- nn
    } else {
      warning("m/z ", ann_mz[i], " could not be matched (nearest is ",
              round(mz_values[nn], 6), ", Δ = ", round(diffs[nn], 4), " Da). Skipping.",
              call. = FALSE)
      feat_idx[i] <- NA_integer_
    }
  }
}

n_matched   <- sum(!is.na(feat_idx))
n_unmatched <- sum(is.na(feat_idx))

if (n_unmatched > 0) {
  warning(n_unmatched, " annotation(s) could not be matched to any feature and will be ignored.",
          call. = FALSE)
  ann      <- ann[!is.na(feat_idx), ]
  feat_idx <- feat_idx[!is.na(feat_idx)]
}

message("PeakMe import: matched ", n_matched, " / ", nrow(ann) + n_unmatched,
        " annotations to MSE features")

# =============================================================================
# 4. Attach annotations to fData()
# =============================================================================
fd <- fData(mse)

# Initialise annotation columns with NA
fd$peakme_label      <- NA_character_
fd$peakme_starred    <- NA
fd$peakme_confidence <- NA_integer_
fd$peakme_annotator  <- NA_character_

fd$peakme_label[feat_idx]   <- ann$label_name
fd$peakme_starred[feat_idx] <- if ("starred" %in% colnames(ann))
                                  as.logical(ann$starred)
                                else NA
fd$peakme_confidence[feat_idx] <- if ("confidence" %in% colnames(ann))
                                     suppressWarnings(as.integer(ann$confidence))
                                   else NA_integer_
fd$peakme_annotator[feat_idx]  <- if ("annotator" %in% colnames(ann))
                                     ann$annotator
                                   else NA_character_

fData(mse) <- fd

# =============================================================================
# 5. Coverage summary
# =============================================================================
n_annotated   <- sum(!is.na(fd$peakme_label))
n_unannotated <- n_features - n_annotated
pct           <- round(100 * n_annotated / n_features, 1)

message("")
message("── Coverage ──────────────────────────────────────────────────────────")
message("  Total features : ", n_features)
message("  Annotated      : ", n_annotated, " (", pct, "%)")
message("  Unannotated    : ", n_unannotated)

label_counts <- sort(table(fd$peakme_label[!is.na(fd$peakme_label)]),
                     decreasing = TRUE)
message("")
message("── Label breakdown ───────────────────────────────────────────────────")
for (nm in names(label_counts)) {
  message("  ", formatC(nm, width = 20, flag = "-"), " ", label_counts[[nm]])
}
message("")

# Assign updated MSE back to the original variable name in the global env
assign(cfg$msi_object, mse, envir = .GlobalEnv)
message("PeakMe import: updated '", cfg$msi_object, "' with annotation columns")

# =============================================================================
# 6. Create MSE_clean (filtered object)
# =============================================================================
if (length(cfg$labels_to_remove) > 0) {
  labels_lower  <- tolower(cfg$labels_to_remove)
  remove_mask   <- tolower(fd$peakme_label) %in% labels_lower

  if (cfg$unannotated == "remove") {
    remove_mask[is.na(fd$peakme_label)] <- TRUE
  }

  n_removed <- sum(remove_mask)
  n_kept    <- n_features - n_removed

  if (n_kept == 0) {
    warning("All features would be removed — MSE_clean was NOT created. ",
            "Check your labels_to_remove.", call. = FALSE)
  } else {
    MSE_clean <- mse[!remove_mask, ]
    assign("MSE_clean", MSE_clean, envir = .GlobalEnv)

    message("── MSE_clean ──────────────────────────────────────────────────────────")
    message("  Removed : ", n_removed, " features (labels: ",
            paste(cfg$labels_to_remove, collapse = ", "), ")")
    if (cfg$unannotated == "remove") {
      message("           + unannotated features (--unannotated=remove)")
    }
    message("  Kept    : ", n_kept, " features")
    message("  Created : MSE_clean in your R session")
    message("")
  }
} else {
  message("No labels_to_remove specified — MSE_clean was not created.")
  message("Set labels_to_remove in the config block to filter the experiment.")
  message("")
}

# =============================================================================
# 7. Optional: save to file (CLI --output only)
# =============================================================================
if (!interactive() && !is.null(args$output)) {
  save_vars <- cfg$msi_object
  if (exists("MSE_clean", envir = .GlobalEnv)) save_vars <- c(save_vars, "MSE_clean")
  save(list = save_vars, file = args$output, envir = .GlobalEnv)
  message("Saved to ", args$output)
}

message("PeakMe import: done.")
