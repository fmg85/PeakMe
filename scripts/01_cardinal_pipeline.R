# 01_cardinal_pipeline.R — Cardinal MSI preprocessing pipeline.
#
# Processes raw .imzML data through normalization, smoothing, peak picking,
# peak alignment, and feature filtering.
#
# Each step writes a numbered .rds checkpoint. If a checkpoint exists on startup
# the step is skipped — run is idempotent and resumable after any interruption.
#
# Interruption protection (layered):
#   1. EC2 hibernation (SIZE=128 instances): AWS saves full RAM state to EBS and
#      resumes mid-execution — Cardinal continues from the exact instruction.
#      No R code change required; this is transparent.
#   2. Step-level .rds checkpoints + S3 sync (all instances): if the job restarts
#      without hibernation, it resumes from the last completed step.
#   3. Spot termination flag (check_spot_termination): exits cleanly between steps
#      for SIZE=256 stop-behavior instances.
#
# Usage (on instance):
#   cd /mnt/ebs-data/work/LargeMSIproc
#   Rscript scripts/01_cardinal_pipeline.R
#
# Usage (local laptop):
#   Rscript scripts/01_cardinal_pipeline.R
#   (S3_BUCKET="" silences all S3 calls; paths default to data/imzml/ and outputs/)

library(Cardinal)
library(BiocParallel)

# ── Source helpers ────────────────────────────────────────────────────────────
# Works whether called from project root or scripts/ subdirectory
.script_dir <- tryCatch(
  dirname(normalizePath(sys.frame(1)$ofile, mustWork = FALSE)),
  error = function(e) getwd()
)
source(file.path(.script_dir, "../R/checkpoint_utils.R"))

# ── Paths from env vars (local fallbacks for laptop use) ─────────────────────
DATA_DIR  <- Sys.getenv("INPUT_DIR",  file.path(.script_dir, "../data/imzml"))
OUT_DIR   <- Sys.getenv("OUTPUT_DIR", file.path(.script_dir, "../outputs"))
LOG_DIR   <- Sys.getenv("LOG_DIR",    file.path(.script_dir, "../logs"))
S3_BUCKET <- Sys.getenv("S3_BUCKET",  "")

dir.create(OUT_DIR,  showWarnings = FALSE, recursive = TRUE)
dir.create(LOG_DIR,  showWarnings = FALSE, recursive = TRUE)

# ── Logging to file ───────────────────────────────────────────────────────────
log_out <- file(file.path(LOG_DIR, "pipeline_output.txt"),   open = "wt")
log_msg <- file(file.path(LOG_DIR, "pipeline_messages.txt"), open = "wt")
sink(log_out, split = TRUE)
sink(log_msg, type = "message", split = TRUE)
on.exit({
  sink(type = "message")
  sink()
  close(log_msg)
  close(log_out)
}, add = TRUE)

log_step(sprintf("Cardinal version: %s", as.character(packageVersion("Cardinal"))))
log_step(sprintf("Working directory: %s", getwd()))
log_step(sprintf("Input directory:   %s", DATA_DIR))
log_step(sprintf("Output directory:  %s", OUT_DIR))
log_step(sprintf("S3 bucket:         %s", if (nchar(S3_BUCKET) > 0) S3_BUCKET else "(none — local only)"))

# ── Restore S3 checkpoints if restarting on a fresh instance ─────────────────
# On a hibernation resume this is skipped (checkpoints already on local EBS).
# On a stop/restart, this syncs any checkpoints that spot-monitor saved to S3.
restore_checkpoints_from_s3(checkpoint_dir = OUT_DIR, s3_bucket = S3_BUCKET)

# ── Locate imzML file ─────────────────────────────────────────────────────────
imzml_files <- list.files(DATA_DIR, pattern = "\\.imzML$", full.names = TRUE)
if (length(imzml_files) == 0) {
  stop(sprintf(
    "No .imzML files found in %s\n  On instance: aws s3 cp s3://%s/inputs/data.imzML %s/",
    DATA_DIR, S3_BUCKET, DATA_DIR
  ))
}
if (length(imzml_files) > 1) {
  log_step(sprintf("Multiple imzML files found; using first: %s", basename(imzml_files[1])))
}
imzml_path <- imzml_files[1]
log_step(sprintf("Input file: %s", imzml_path))

# ── Cardinal processing parameters ───────────────────────────────────────────
# SerialParam with progressbar for visibility; switch to SnowParam for multi-core
setCardinalBPPARAM(SerialParam(progressbar = TRUE))

# ── Step 1: Read raw data ─────────────────────────────────────────────────────
ckpt1 <- file.path(OUT_DIR, "01_GCPL_raw.rds")
check_spot_termination()

if (file.exists(ckpt1)) {
  log_step("--- Step 1: loading checkpoint ---")
  GCPL <- load_checkpoint(ckpt1)
} else {
  log_step("--- Step 1: readMSIData ---")
  GCPL <- readMSIData(imzml_path)
  save_checkpoint(GCPL, ckpt1, s3_bucket = S3_BUCKET)
}
print(GCPL)

# ── Steps 2–4: Normalize + smooth + process ───────────────────────────────────
# RMS normalization preferred over TIC due to matrix effects.
# Savitzky-Golay smoothing (replaces removed "pag" method from Cardinal 2.x).
# process() executes the lazy queue; this is the longest step.
ckpt4 <- file.path(OUT_DIR, "04_msa_pre_norm_smooth.rds")
check_spot_termination()

if (file.exists(ckpt4)) {
  log_step("--- Steps 2-4: loading checkpoint ---")
  msa_pre <- load_checkpoint(ckpt4)
} else {
  log_step("--- Step 2: normalize (rms) ---")
  msa <- normalize(GCPL, method = "rms")

  log_step("--- Step 3: smoothSignal (sgolay) ---")
  msa <- smoothSignal(msa, method = "sgolay")

  log_step("--- Step 4: process (normalize + smooth) ---")
  msa_pre <- process(msa)
  save_checkpoint(msa_pre, ckpt4, s3_bucket = S3_BUCKET)
}
print(msa_pre)
rm(msa); gc()

# ── Step 5: Peak picking ──────────────────────────────────────────────────────
# "cwt" removed in Cardinal 3.x; "mad" (local MAD-based noise estimate) used instead.
ckpt5 <- file.path(OUT_DIR, "05_mse_pick.rds")
check_spot_termination()

if (file.exists(ckpt5)) {
  log_step("--- Step 5: loading checkpoint ---")
  mse_pick <- load_checkpoint(ckpt5)
} else {
  log_step("--- Step 5: peakPick (mad, SNR=3) ---")
  mse_pick <- peakPick(msa_pre, method = "mad", SNR = 3)
  mse_pick <- process(mse_pick)
  save_checkpoint(mse_pick, ckpt5, s3_bucket = S3_BUCKET)
}
print(mse_pick)
rm(msa_pre); gc()

# ── Step 6: Peak alignment ────────────────────────────────────────────────────
# 10 ppm appropriate for timsTOF flex mass accuracy.
# peakAlign is lazy in Cardinal 3.x; process() executes it.
ckpt6 <- file.path(OUT_DIR, "06_mse_peaks_aligned.rds")
check_spot_termination()

if (file.exists(ckpt6)) {
  log_step("--- Step 6: loading checkpoint ---")
  mse_peaks <- load_checkpoint(ckpt6)
} else {
  log_step("--- Step 6: peakAlign (10 ppm) ---")
  mse_peaks <- peakAlign(mse_pick, tolerance = 10, units = "ppm")
  mse_peaks <- process(mse_peaks)
  save_checkpoint(mse_peaks, ckpt6, s3_bucket = S3_BUCKET)
}
print(mse_peaks)
rm(mse_pick); gc()

# ── Step 7: Feature filtering ─────────────────────────────────────────────────
# peakFilter replaces removed subsetFeatures() from Cardinal 2.x.
# freq.min=0.001 retains peaks present in >=0.1% of pixels (permissive for untargeted).
ckpt7 <- file.path(OUT_DIR, "07_mse_final_filtered.rds")
check_spot_termination()

if (file.exists(ckpt7)) {
  log_step("--- Step 7: loading checkpoint ---")
  mse_final <- load_checkpoint(ckpt7)
} else {
  log_step("--- Step 7: peakFilter (freq.min=0.001) ---")
  mse_final <- peakFilter(mse_peaks, freq.min = 0.001)
  mse_final <- process(mse_final)
  save_checkpoint(mse_final, ckpt7, s3_bucket = S3_BUCKET)
}
print(mse_final)
rm(mse_peaks); gc()

# ── Complete ──────────────────────────────────────────────────────────────────
log_step("=== Pipeline complete ===")
log_step(sprintf("Final dataset: %d features, %d pixels",
                 nrow(mse_final), ncol(mse_final)))
log_step(sprintf("Checkpoints in: %s/", OUT_DIR))
if (nchar(S3_BUCKET) > 0) {
  log_step(sprintf("S3 backup:      s3://%s/checkpoints/", S3_BUCKET))
}
