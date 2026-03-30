# Changelog

All notable changes to PeakMe are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## Unreleased

- fix: rename default output folder from `peakme_export` → `peakme_upload`
- feat: R script version numbers displayed on instructions page next to each download button (v1.3.0 / v1.1.0); version comment in script header so downloaded files are self-identifying in R script, docs, and instructions page (clearer naming — "upload" matches the next step of uploading to PeakMe)
- feat: reference layers — tap the ion image card to cycle through: Ion image → TIC spectrum → Fluorescence → Ion + outline → repeat; only layers with data available are shown
- feat: TIC spectrum PNGs auto-generated per ion by the export script (±2 Da window around peak, dark theme, included in ZIP); disable with `export_tic = FALSE` or `--no-tic` on CLI
- feat: fluorescence image + outline upload per dataset (project page → "Reference images" expand)
- fix: session annotation counter no longer inflates when re-annotating an already-labelled ion (was counting upserts as new annotations, making progress display higher than actual DB count)
- fix: "X left" counter showed wrong non-zero value at exhaustion and "All done!" message showed wrong total — root cause: React Query background refetches updated `my_annotation_count` mid-session causing double-counting; fixed by snapshotting the baseline at session start and refreshing the dataset query on queue exhaustion
- feat: `starred` column added to annotation CSV/JSON exports (both project-wide and per-dataset)
- feat: new `r-scripts/peakme_import.R` — attaches PeakMe labels back to MSImagingExperiment, creates `MSE_clean` by filtering unwanted labels
- fix: `r-scripts/export_cardinal_pngs.R` default `msi_object` changed to `"MSE_process"`
- feat: instructions page now has two download buttons (Export script + Import script) and a Part 2 section documenting the import workflow

---

## 2026-03-29

- feat: session start screen when returning to a partially-annotated dataset — choose Resume, Start from beginning, or Review starred
- fix: annotation progress bar now tracks live during a session (was using queue buffer size, not actual annotation count)
- feat: header shows "X left" count during resume mode
- fix: swipe animation — card no longer "flips back" after being swiped off screen (was caused by React reusing the same DOM element; fixed with key={ion.id})
- fix: swipe animation — card now fully exits before next card appears (timeout was 250ms, transition 300ms; fixed to 320ms)
- feat: ion image is now significantly larger — fills available screen height instead of fixed vmin size
- feat: new card fades in smoothly after each annotation
- fix: R export — ion images were vertically flipped vs. old script (writePNG row-1=top convention; removed incorrect y-flip)
- fix: undo now always returns to exactly the ion that was annotated, not a potentially random queue position

## 2026-03-28

- feat: inline label editing — name, color, keyboard shortcut editable without delete/recreate
- feat: upload progress bar with % during transfer, pulse animation during server ingestion
- feat: delete button on error/pending/processing datasets to clear stale uploads
- fix: async dataset ingestion — upload now returns immediately (202), ingestion runs in background
- perf: parallel S3 uploads with ThreadPoolExecutor (20 workers) — ~20× faster ingestion
- fix: S3 client made thread-safe via threading.local()
- fix: label Edit button was invisible (✎ glyph at text-xs in gray-on-gray)
- perf: R export script 10-50× faster — replaced R graphics device with png::writePNG()
- perf: R export script — vectorised pixel fill, pre-computed coordinate mapping, fixed materialization threshold
- feat: R script interactive mode detects MSImagingExperiment by variable name
- fix: instructions page — add `png` dependency, remove defunct --object-name flag, update timing tip

## 2026-03-27

- fix: Vercel proxy rewrites `/api/*` → EC2 backend server-side, bypassing browser DNS filtering
- fix: removed `VITE_API_URL` env var — frontend now uses relative paths via Vercel proxy
- feat: Google OAuth login (in addition to OTP)
- feat: 6-digit OTP email login replacing magic links (magic links broken by Stanford/corporate email scanners)
- feat: 4-direction swipe gestures for annotation (configurable per label)
- feat: configurable swipe directions per label (DirectionPicker in project settings)
- feat: export CSV per-dataset and project-wide with real filenames
- feat: instructions page with R script download (auto-synced from r-scripts/ at build time)
- feat: profile display name editing
- fix: logo size, undo bug (was doing window.location.reload), "Review all ions" no-op
- refactor: R script simplified to MSImagingExperiment-first interface

## Earlier

- feat: annotation queue with strategy (random, sequential, starred, all)
- feat: project/dataset/label management
- feat: ZIP upload and ion ingestion pipeline
- feat: S3 image storage with presigned URLs
- feat: Supabase auth integration
- feat: annotation upsert (label + confidence)
- feat: stats page per project
- feat: CSV/JSON annotation export
