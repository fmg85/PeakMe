# Changelog

All notable changes to PeakMe are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## 2026-08-07

- **breaking: `DELETE /api/datasets/{id}` now requires you to own the parent project** (or be an admin), matching the rule `DELETE /api/projects/{id}` has always enforced. Previously the endpoint checked only that you were *signed in* — and since anyone can self-serve a Supabase account, and `GET /api/projects` lists every project, any account on the internet could delete any dataset. That cascades `datasets → ions → annotations`, destroying **every** annotator's work for that dataset plus its S3 images, with no recovery. Non-owners now get 403. If you share projects, the project creator (or an admin) has to do the deleting — say so and it can be replaced with a proper membership model
- fix: **offline undo could be silently discarded.** If the queued `DELETE` for an undo hit a network error or timeout while syncing, the error was swallowed and the mutation was deleted from the queue anyway — the annotation stayed live on the server while your device showed the ion as unannotated, diverging permanently with no error. Only a genuine 404 now counts as "already gone"; anything else re-queues for the next reconnect (5 regression tests, verified failing against the old code)
- fix: **annotating fast, or holding a label key, mislabelled ions and skipped others.** `advance()` runs on a 320 ms timer, so the card didn't change until it fired — every extra key press or swipe in that window re-annotated the *same* ion (last press winning, overwriting the label you meant for the next one) and queued another advance, each silently dropping an ion from the queue without ever showing it. Held keys auto-repeat ~30×/sec, so one long press could skip ~14 ions and then show "All done!". Added an in-flight guard and an `e.repeat` check
- fix: **ML score-sorted ion ranking had never actually run.** The bulk `UPDATE` that writes `ions.sort_order` / `ions.ml_score` used a form SQLAlchemy 2.0 rejects outright, and the caller swallowed the error with a bare `except Exception: pass` — so every ingest since the feature shipped downloaded all ion images, loaded the ONNX model, burned minutes of CPU, then threw the result away and left ions in upload order, silently. `ml_score` was `NULL` on every row and the ~68% annotation saving in ADR-011 was never delivered. Fixed the UPDATE (3 tests that reproduce the original error) and replaced the bare `except` with a logged exception, so a future scoring failure is visible instead of invisible. Existing datasets keep their current order — they are not re-scored, because re-ranking ions that already carry annotations would shift the queue cursor under any open session
- fix: the deploy workflow could report success while production ran an un-migrated schema. `alembic upgrade head` lived inside the "EC2 is behind" branch, so if a migration failed after the containers had already swapped, the retry (or the nightly run) took the `BEHIND=0` path, skipped the migration entirely, and then swallowed the resulting readiness 503 with `|| echo` — exiting green every night while prod stayed broken on new code + old schema. The migration now runs on both paths (a no-op at head, so it costs nothing and lets a half-deploy heal itself), and an un-migrated schema is always fatal. A slow Supabase wakeup stays non-fatal on no-deploy runs, so the nightly job doesn't go red routinely and get muted
- fix: the database keepalive no longer depends on GitHub Actions. GitHub disables `schedule:` triggers after 60 days of repository inactivity, and the nightly workflow was the only thing pinging the DB — so a quiet repo would have silently stopped the keepalive, letting the Supabase free tier pause the project ~7 days later and taking the app **and its annotation data** offline until manually restored. The failure mode was self-concealing (push-triggered deploys keep working) and unfixable with another scheduled workflow, since the same rule would disable that one too. The API now pings its own DB every 6h from a lifespan task, independent of GitHub, CI, and repo activity (ADR-015, 6 tests)
- docs: two ADRs were both numbered 011, making "see ADR-011" ambiguous — the presigned-S3 one is now ADR-014 (nothing referenced it externally)
- fix: dataset and project deletes are now reliable — S3 cleanup moved off the async event loop (`run_in_executor`), `passive_deletes=True` on all cascade relationships so SQLAlchemy trusts the DB-level `ON DELETE CASCADE` instead of loading every child row first, and delete calls get a 30s timeout instead of the global 10s. Deleting a large dataset or project no longer intermittently times out
- fix: project delete now also removes the S3 images for all of its datasets (previously orphaned in the bucket)
- fix: a failed delete now shows an error instead of silently doing nothing

## 2026-06-14

- chore: CI now gates the EC2 deploy on automated checks — every push to `main` runs `ruff` (bug-focused: undefined names, dead imports, syntax), an app import smoke-test, and `alembic upgrade head` against a throwaway Postgres **before** deploying. A failing check skips the deploy and leaves prod on the last good commit; direct push-to-main (incl. mobile sessions) is unchanged. Stops broken migrations from ever reaching the production database. See ADR-013.
- chore: added a scoped, risk-based test strategy (CLAUDE.md "Testing") + dev tooling (`ruff`, `pytest`); removed 6 unused imports flagged by ruff (no behaviour change)
- fix: `npm run lint` was broken (ESLint 9 with no flat config) — migrated to `eslint.config.js`, wired lint into the build + CI, and fixed the issues it surfaced: 4 unsafe non-null assertions on optional chains in the annotate image layers (`dataset?.x!` → `dataset?.x ?? undefined`, runtime-identical) and an undocumented empty catch
- chore: post-deploy gate now hits a real readiness probe (`/readiness` — DB reachable + schema migrated to the expected Alembic head) instead of the static `/health`, so a deploy with a broken DB or unmigrated schema fails fast instead of reporting success. Adds the endpoint (3 tests) and a retrying, fatal post-deploy check; readiness also doubles as the Supabase keepalive
- chore: added an `r-lint` CI job that parses both R scripts (as-is and with `\`→`/`) so a syntax error can't silently ship to researchers. Corrected the CLAUDE.md backslash rule — verified the historical Vite `\`→`/` rewrite does **not** occur (deployed scripts are byte-identical to source)
- fix: `peakme_export.R` (v1.1.1) failed to parse and so could not run via `source()`/`Rscript` — three top-level `if/else` assignments had `else` on its own line, which R rejects (`unexpected 'else'`), making annotation export back into Cardinal impossible. Caught by the new `r-lint` job; fixed by keeping each `else` on the same line. Re-download the script if you hit `unexpected 'else'`
- chore: added the backend pytest suite (24 tests) over the security- and data-integrity-critical paths — JWT verification (`_verify_token`: ES256/HS256 accept, unknown-kid/tampered-sig/wrong-secret/`alg:none` reject), the account-merge in `get_current_user` (UUID hit, email-fallback creates no duplicate, auto-create, missing-`sub`→401), the annotate upsert (second label wins, single row, 404/422 paths), the queue cursor (no gap/overlap, unannotated-first excludes own), and the project ownership 403. Runs against an ephemeral Postgres; wired into CI as a gating `backend-tests` job
- chore: tidied the new offline tests to a zero-warning lint baseline (dropped an unused var + redundant eslint-disable directives)
- chore: added the frontend offline-sync test suite (vitest + fake-indexeddb), 27 tests over the highest data-loss-risk code: the sync reconciler (delete-only-after-confirm, 404-drop, 401-park, network-stop, 5xx-requeue, star convergence, superseded-row skip), the IndexedDB queue (atomic snapshot replace, batch ordering + labelFilter precedence, collapse), the offline mutation wrappers (collapse/supersede, online error propagation), and the service-worker image-cache key. Wired into the build + CI so a failing test blocks the frontend deploy
- fix: installed iOS PWA header cut off under the status bar — the app used a translucent status bar with `viewport-fit=cover`, rendering content full-screen beneath the iOS clock/battery so the sticky header (incl. the back button) was unreachable. Switched to an opaque status bar; content now sits below it.
- fix: project page "Sample type" / "Description" upload fields overflowed off the right edge on narrow (mobile) screens — they now stack vertically on small screens and shrink to fit.
- fix: after offline annotations sync on reconnect, the dataset cards (annotation counts + label summaries) now refresh automatically — the reconciler invalidates the relevant React Query caches on a successful flush, so no manual pull-to-refresh is needed.

## 2026-06-13

- feat: offline companion (installable PWA) — PeakMe can now be installed to a phone/tablet/desktop home screen and used **offline**. A platform-aware install prompt triggers the real install dialog on Android/desktop Chrome and shows guided "Add to Home Screen / Add to Dock" steps on iOS/macOS Safari (Apple has no install API)
- feat: "⤓ Download for offline" on the dataset session screen — caches a chosen number of ions (next 1,000 / 3,000 / whole dataset) with an optional **Include TIC spectra** toggle and a live size estimate (≈8 KB/ion, ≈25 KB extra per TIC). Ion images are stored in the service-worker cache so the existing image views work offline unchanged
- feat: offline annotation — annotate, star, and undo with no connection. Actions are queued in IndexedDB and replayed automatically on reconnect/app-foreground; idempotent against the existing `(ion_id, user_id)` annotate upsert, so re-sync never duplicates. A sync/offline status indicator shows pending count and progress
- docs: offline image caching requires a CORS `GET` rule on the `peakme-ions` S3 bucket for the app origins (see `docs/deployment.md`); recorded as ADR-012

## 2026-05-22

- feat: live ingestion progress — the ingest pipeline now publishes `processed_ions / total_ions` as PNGs upload to S3 (new `processed_ions` column, migration 0006). Shown as a moving progress bar per dataset in the upload queue and as a percentage on the dataset card, so you can see ingestion is advancing and not stuck
- feat: bulk dataset upload — select multiple ZIPs at once; each becomes a dataset named after its file, with per-file progress and status. Datasets upload **and** ingest one at a time (the queue waits for each to finish ingesting before starting the next) so the backend is never hit with parallel ingestions that overload it
- fix: include `Content-Type` in the presigned S3 PUT signature so direct uploads no longer fail with a generic "network error" (browser sends `Content-Type` for the file; S3 rejects any header missing from the signature)
- fix: raise the upload-flow API timeout (prepare-upload / ingest / cleanup) from 10s to 60s so uploads don't fail prematurely when the backend is busy ingesting other datasets

## 2026-05-21

- feat: upload ZIPs directly to S3 via presigned URLs, bypassing Vercel's request body size limit; large datasets now upload reliably

## 2026-05-21 (2)

- fix: reduce gunicorn workers from 4 to 2 to prevent OOM crash on t3.small (1.9GB RAM); ML model loaded per-worker was exhausting memory

## 2026-05-21 (3)

- fix: `peakme_import.R` v1.5.0 — ZIP now uses flat layout (files at archive root); absolute-path output dirs no longer produce unreadable archives that fail on upload
- feat: `peakme_import.R` v1.5.0 — new `--sort-by mz|mean|max|freq` argument; annotators now see highest-intensity (or most-detected) ions first instead of lowest m/z first

## 2026-04-20

- feat: ML score-sorted ion queue — after a dataset ingests, MobileNet-V3-Small (AUC 0.9283) ranks all ions by P(on_tissue) so annotators see biologically relevant ions first; saves ~68% of annotation effort vs. random order
- feat: `ml_score` field exposed on `GET /api/datasets/{id}/ions/queue` response
- feat: `matrix_type` column added to datasets (defaults to DHAP) for future non-DHAP support

## 2026-04-01

- fix: display name now synced from Google JWT (full_name) on login when the stored name is still the auto-generated email prefix
- feat: stats page redesign — completion hero, label distribution bar, per-annotator cards, PeakMe Community cross-project section
- fix: enable Row Level Security on all public tables — closes direct PostgREST access for anon/authenticated roles (Supabase security linter ERRORs)
- fix: re-annotation pass progress now tracks correctly — "Reviewing all · X / Y" counter and progress bar advance as ions are reviewed instead of staying at 0/100%
- docs: add ADR-007 (RLS), ADR-008 (global stats), ADR-009 (JWT dual-algorithm + email fallback); add root README.md; fix wrong script name in r-export-workflow.md
- chore: CI check — build fails if source changes land without a CHANGELOG entry, or if R scripts change without updating both docs/r-export-workflow.md and InstructionsPage.tsx
- docs: ADR-010 — ion identity contract: mz_value is the canonical Cardinal matching key; sort_order is a display hint only and must never be exported to R — completion hero with progress bar and % complete, full-width label distribution stacked bar with colour-coded legend, per-annotator cards showing % of total ions, new PeakMe Community section with cross-project global stats
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
