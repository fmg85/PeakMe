# Changelog

All notable changes to PeakMe are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## 2026-04-01

- fix: display name now synced from Google JWT (full_name) on login when the stored name is still the auto-generated email prefix
- feat: stats page redesign — completion hero, label distribution bar, per-annotator cards, PeakMe Community cross-project section
- fix: enable Row Level Security on all public tables — closes direct PostgREST access for anon/authenticated roles (Supabase security linter ERRORs)
- fix: re-annotation pass progress now tracks correctly — "Reviewing all · X / Y" counter and progress bar advance as ions are reviewed instead of staying at 0/100% — completion hero with progress bar and % complete, full-width label distribution stacked bar with colour-coded legend, per-annotator cards showing % of total ions, new PeakMe Community section with cross-project global stats
- feat: new `GET /api/stats` global endpoint returning platform-wide ion count, annotation count, unique annotators, and label distribution
- feat: `StatsOut` extended with `total_annotated_ions` and `label_distribution` fields

## 2026-03-31

- fix: projects page shows HTTP status + detail when API call fails (was silent grey boxes)
- fix: Google OAuth login — email-based user lookup prevents duplicate-email 500 crash; spinner held during PKCE code exchange so `?code=` param is not stripped by React Router
- fix: token verification errors (including JWKS network failures) now return 401 instead of 500
- fix: 10s request timeout on API client — unreachable backend shows error message instead of hanging indefinitely
- chore: deploy script uses `set -e` + post-deploy health check so failures surface in GitHub Actions instead of silently passing
- chore: SSH action retries 3× with 30s timeout to handle brief post-reboot unavailability

## 2026-03-30

- fix: rename default output folder `peakme_export` → `peakme_upload` in R import script
- fix: update default `msi_object` to `mse_process` (lowercase convention)
- fix: update default image resolution to 720×720; remove stale public R files
- fix: rename R scripts to `peakme_import.R` / `peakme_export.R`; swap Import/Export button order and labels so Import (Cardinal→PeakMe) comes first
- fix: remove backslash escapes from R script strings — Vercel converts `\` → `/` when serving static `.R` files, causing parse errors on download
- feat: R script version numbers in header comment and displayed next to each download button on instructions page
- feat: TIC spectrum — axis labels (`m/z`, `Total Ion Intensity`), top-5 peak annotations with m/z to 4 d.p., configurable window (default ±1 Da)
- fix: TIC `axis()` crash — `labels` argument requires `at` parameter (v1.3.2)
- perf: TIC spectrum visual polish — white hairline bars, 50% opacity marker, tighter margins (v1.3.3)
- perf: TIC PNG rendered at 2× resolution with square dimensions matching ion image for seamless layer transition (v1.3.4)
- perf: TIC square margin tuned; fluorescence+outline added as fourth layer in cycle (v1.3.5)
- perf: TIC spectrum label improvements — 2× axis fonts, 2.5× peak label font, collision-aware placement, angled dotted leader lines (v1.3.6)
- feat: hold / long-press ion image card to peek TIC spectrum without cycling layers
- fix: always draw dotted leader line for every peak label (v1.3.7)
- fix: TIC PNG pixel dimensions now exactly match ion image (v1.3.8)
- fix: strip 144 DPI metadata from TIC PNG — caused browser to render it at wrong size
- fix: leader line `lwd` 0.7→1.5 — was sub-pixel at res=72, making guide lines invisible
- fix: TIC guide lines always visible; target m/z marker colour and placement improvements (v1.4.1)
- fix: remove duplicate target m/z label; guide line and label both rendered in orange (v1.4.2)

## 2026-03-29

- feat: reference layers — tap ion image card to cycle Ion → TIC spectrum → Fluorescence → Overlay → repeat; only layers with data are shown
- feat: TIC spectrum PNGs auto-generated per ion by export script (±2 Da window, dark theme, included in ZIP); disable with `export_tic = FALSE` / `--no-tic`
- feat: fluorescence image + outline upload per dataset (project page → "Reference images")
- fix: ZIP upload broken — `zipfile.ZipFile` not thread-safe in parallel `ThreadPoolExecutor`; pre-read all bytes single-threaded before dispatching
- fix: overlay layer uses native PNG alpha transparency instead of `mix-blend-mode: multiply` (wrong colours)
- fix: cursor-based pagination for ion queue — offset-based pagination skipped ions as annotations removed them from the filtered set
- feat: instructions page — workflow diagram (8-step orange/purple) + collapsible sections
- feat: per-label annotation breakdown shown on "All done!" screen and project page
- feat: review-by-label mode — filter annotation queue to re-annotate a specific label
- fix: Resume button hidden when dataset is fully annotated; "Start from beginning" promoted as primary action
- fix: rename script buttons to "PeakMe Import" (orange, Cardinal→PeakMe) and "PeakMe Export" (purple, PeakMe→R)
- feat: starred flag included in annotation CSV/JSON exports
- feat: `peakme_import.R` post-processing script — attaches PeakMe labels to `MSImagingExperiment`, filters by label to produce clean subset objects
- fix: session annotation counter no longer inflates when re-annotating an already-labelled ion (upserts were being counted as new)
- fix: "X left" counter and "All done!" total were wrong — fixed by snapshotting baseline at session start and refreshing on queue exhaustion
- fix: project delete ✕ button no longer hidden behind label pills
- fix: project detail annotation counts refresh automatically when leaving annotate page
- feat: unlimited undo — full stack of all annotations in the current session
- feat: delete datasets and projects
- fix: session start screen shown reliably; "Start from beginning" counter correct
- fix: swipe card no longer flips back after fly-off animation
- fix: swipe animation timing — card fully exits before next appears
- feat: ion image fills available screen height instead of fixed vmin size
- feat: new card fades in smoothly after each annotation
- fix: R export — ion images were vertically flipped (removed incorrect y-flip)
- fix: undo always returns to the exact ion that was annotated

## 2026-03-28

- feat: session start screen — Resume, Start from beginning, or Review starred when returning to a partially-annotated dataset
- feat: "What's new" changelog modal in profile dropdown
- feat: inline label editing — name, colour, keyboard shortcut editable without delete/recreate
- feat: upload progress bar with % during transfer; pulse animation during server ingestion
- feat: delete button on error/pending/processing datasets to clear stale uploads
- fix: async dataset ingestion — upload returns immediately (202), ingestion runs in background
- perf: parallel S3 uploads with `ThreadPoolExecutor` (20 workers) — ~20× faster ingestion
- fix: S3 client made thread-safe via `threading.local()`
- fix: label Edit button was invisible (✎ glyph at `text-xs` in gray-on-gray)
- perf: R export script 10-50× faster — replaced R graphics device with `png::writePNG()`
- perf: R export script — vectorised pixel fill, pre-computed coordinate mapping
- feat: R script interactive mode detects `MSImagingExperiment` by variable name
- fix: instructions page — add `png` dependency, remove defunct `--object-name` flag, update timing tip

## 2026-03-27

- fix: Vercel proxy rewrites `/api/*` → EC2 backend server-side, bypassing browser DNS filtering
- fix: removed `VITE_API_URL` env var — frontend uses relative paths via Vercel proxy
- feat: Google OAuth login (in addition to OTP email codes)
- feat: 6-digit OTP email login replacing magic links (magic links broken by email scanners)
- feat: 4-direction swipe gestures for annotation (configurable per label)
- feat: configurable swipe directions per label (DirectionPicker in project settings)
- feat: export CSV per-dataset and project-wide with real filenames
- feat: instructions page with R script download (auto-synced from `r-scripts/` at build time)
- feat: profile display name editing
- fix: logo size, undo bug (was doing `window.location.reload`), "Review all ions" no-op
- refactor: R script simplified to `MSImagingExperiment`-first interface

## Earlier

- feat: annotation queue with strategy (random, sequential, starred, all)
- feat: project/dataset/label management
- feat: ZIP upload and ion ingestion pipeline
- feat: S3 image storage with presigned URLs
- feat: Supabase auth integration
- feat: annotation upsert (label + confidence)
- feat: stats page per project
- feat: CSV/JSON annotation export
