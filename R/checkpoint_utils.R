# checkpoint_utils.R — Checkpoint helpers for large Cardinal MSI processing jobs.
#
# Works on both the EC2 Spot instance (with S3 sync) and a local laptop
# (S3_BUCKET="" → S3 operations are silently skipped).
#
# Primary interruption protection: EC2 hibernation (transparent to R, handled by AWS).
# Secondary: step-level .rds checkpoints (save_checkpoint) synced to S3.
# Tertiary: /tmp/.spot-terminate flag (check_spot_termination) for stop-behavior fallback.
#
# Usage in pipeline scripts:
#   source(file.path(dirname(sys.frame(1)$ofile), "../R/checkpoint_utils.R"))

# ── Environment ───────────────────────────────────────────────────────────────

.S3_BUCKET       <- Sys.getenv("S3_BUCKET",       "")
.CHECKPOINT_DIR  <- Sys.getenv("CHECKPOINT_DIR",   "outputs")
.LOG_DIR         <- Sys.getenv("LOG_DIR",          "logs")

# ── Logging ───────────────────────────────────────────────────────────────────

#' Write a timestamped log line to stdout and the pipeline log file.
log_step <- function(msg) {
  ts  <- format(Sys.time(), "%Y-%m-%dT%H:%M:%S")
  line <- sprintf("[%s] %s", ts, msg)
  cat(line, "\n", sep = "")
  log_path <- file.path(.LOG_DIR, "pipeline.log")
  if (dir.exists(.LOG_DIR)) {
    cat(line, "\n", sep = "", file = log_path, append = TRUE)
  }
  invisible(NULL)
}

# ── Checkpoint save ───────────────────────────────────────────────────────────

#' Save an R object as an uncompressed .rds checkpoint.
#'
#' Writes atomically (to a .tmp file then renames) to avoid partial writes.
#' If S3_BUCKET is set, immediately copies the file to S3 for durability.
#'
#' @param obj        Object to save (Cardinal MSImagingExperiment or any R object).
#' @param path       Local file path for the checkpoint (e.g. "outputs/04_msa.rds").
#' @param s3_bucket  S3 bucket name. Defaults to S3_BUCKET env var. Empty = skip S3.
#' @param s3_prefix  S3 key prefix. Default: "checkpoints".
save_checkpoint <- function(obj, path,
                             s3_bucket = .S3_BUCKET,
                             s3_prefix = "checkpoints") {
  log_step(sprintf("Saving checkpoint: %s", path))

  # Atomic write: save to .tmp then rename
  tmp_path <- paste0(path, ".tmp")
  saveRDS(obj, tmp_path, compress = FALSE)
  file.rename(tmp_path, path)

  size_gb <- round(file.size(path) / 1e9, 2)
  log_step(sprintf("  Checkpoint saved: %.2f GB", size_gb))

  # Sync to S3 for durability (no-op on laptop)
  if (nchar(s3_bucket) > 0) {
    s3_key <- paste0(s3_prefix, "/", basename(path))
    cmd <- sprintf("aws s3 cp %s s3://%s/%s --quiet", path, s3_bucket, s3_key)
    ret <- system(cmd, ignore.stdout = TRUE)
    if (ret == 0L) {
      log_step(sprintf("  Synced to s3://%s/%s", s3_bucket, s3_key))
    } else {
      warning(sprintf("S3 sync failed for %s (exit code %d). Checkpoint is local only.", path, ret))
    }
  }

  invisible(path)
}

# ── Checkpoint load ───────────────────────────────────────────────────────────

#' Load a checkpoint if it exists, otherwise return NULL.
#'
#' This is the standard pattern already in the pipeline — provided here for
#' consistency and documentation.
#'
#' @param path  Path to the .rds checkpoint file.
#' @return The saved object, or NULL if the file does not exist.
load_checkpoint <- function(path) {
  if (file.exists(path)) {
    log_step(sprintf("Loading checkpoint: %s (%.2f GB)",
                     path, round(file.size(path) / 1e9, 2)))
    readRDS(path)
  } else {
    NULL
  }
}

# ── Spot termination detection ────────────────────────────────────────────────

#' Check for the Spot termination flag and exit cleanly if set.
#'
#' spot-monitor.sh writes /tmp/.spot-terminate when a termination notice is
#' received. Call this between pipeline steps — it exits R cleanly (status 0)
#' so the process is not counted as a failure. The job resumes from the last
#' step-level checkpoint on restart.
#'
#' With hibernation (SIZE=128), AWS resumes the exact R process mid-execution,
#' so this function is rarely reached. It is the primary recovery mechanism for
#' SIZE=256 (stop behavior) instances.
check_spot_termination <- function() {
  if (file.exists("/tmp/.spot-terminate")) {
    log_step("Spot termination flag detected.")
    log_step("Exiting cleanly. Resume from last checkpoint on restart.")
    quit(save = "no", status = 0L)
  }
  invisible(FALSE)
}

# ── S3 restore helper ─────────────────────────────────────────────────────────

#' Restore checkpoint files from S3 if they are missing locally.
#'
#' Useful on a fresh instance (after a non-hibernation stop) where the data EBS
#' volume is reused but a checkpoint was saved to S3 after the last termination.
#'
#' @param checkpoint_dir  Local directory to restore into (default: OUTPUT_DIR env).
#' @param s3_bucket       S3 bucket. Defaults to S3_BUCKET env var.
#' @param s3_prefix       S3 key prefix. Default: "checkpoints".
restore_checkpoints_from_s3 <- function(
    checkpoint_dir = Sys.getenv("OUTPUT_DIR", "outputs"),
    s3_bucket = .S3_BUCKET,
    s3_prefix = "checkpoints") {

  if (nchar(s3_bucket) == 0) {
    log_step("S3_BUCKET not set — skipping S3 restore")
    return(invisible(NULL))
  }

  log_step(sprintf("Restoring checkpoints from s3://%s/%s/ ...", s3_bucket, s3_prefix))
  cmd <- sprintf("aws s3 sync s3://%s/%s/ %s/ --quiet",
                 s3_bucket, s3_prefix, checkpoint_dir)
  ret <- system(cmd, ignore.stdout = TRUE)
  if (ret == 0L) {
    log_step(sprintf("  Restore complete → %s/", checkpoint_dir))
  } else {
    warning(sprintf("S3 restore failed (exit code %d). Continuing without S3 checkpoints.", ret))
  }
  invisible(NULL)
}
