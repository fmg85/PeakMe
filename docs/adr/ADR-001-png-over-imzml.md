# ADR-001: Pre-rendered PNGs over raw imzML ingestion

**Date:** 2026-03-27
**Status:** Accepted

## Context

MSI datasets are produced by mass spectrometers and stored in the imzML format — a pair of files (`.imzML` XML manifest + `.ibd` binary). Parsing this format server-side requires specialised libraries (pyimzML), significant compute time, and substantial RAM for large datasets (>2 GB files are common). The primary use-case of PeakMe is annotation speed: scientists want to click through ion images as fast as possible.

## Decision

Accept **pre-rendered PNG images** as the upload format rather than raw imzML files. Scientists run a provided R script (`r-scripts/peakme_import.R`) on their local machine using the Cardinal MSI package, which exports one PNG per m/z value together with a `metadata.csv`. They then zip and upload the folder to PeakMe.

## Consequences

**Positive:**
- Backend has zero scientific computing dependencies (no pyimzML, numpy, matplotlib)
- Images are deterministic and cacheable forever (S3 + CDN)
- Scientists keep full control over rendering parameters (colormap, normalisation, resolution) in their familiar R environment
- Server-side ingestion is simple: parse CSV + upload PNGs to S3

**Negative:**
- Scientists must have R + Cardinal installed and run an extra step before uploading
- If rendering parameters change, they must re-export and re-upload
- Raw spectral data is not stored in PeakMe (export only covers images, not underlying spectra)

## Alternatives Considered

- **Direct imzML upload with server-side rendering:** Would require Celery workers, pyimzML, and >2 GB file handling. Adds significant operational complexity for a small-team tool. Deferred to a potential future "PeakMe Pro" with beefier infrastructure.
