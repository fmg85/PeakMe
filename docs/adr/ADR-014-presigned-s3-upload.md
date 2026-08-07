# ADR-014: Presigned S3 URLs for ZIP uploads

**Date:** 2026-05-21  
**Status:** Accepted

## Context

The original upload flow sent the ZIP through the browser → Vercel proxy → EC2 → S3.
Vercel buffers the entire request body before forwarding it to the upstream, and imposes
a hard body-size cap (~4.5 MB on Hobby, ~100 MB on Pro). Real MSI datasets are routinely
larger than this limit, so uploads failed silently: the POST never reached EC2 at all.

## Decision

Replace the single `POST /api/datasets/upload` endpoint with a three-step flow:

1. **`POST /api/datasets/prepare-upload`** (JSON body) — creates the `datasets` row with
   `status="pending"` and returns a presigned S3 `PUT` URL (1-hour TTL) plus `dataset_id`.
2. **Browser PUTs the ZIP directly to S3** — no Vercel, no EC2 in the upload path.
   Progress events still work via XHR/axios `onUploadProgress`.
3. **`POST /api/datasets/{id}/ingest`** — sets `status="processing"`, kicks off a
   background task that downloads the ZIP from S3, runs ingest + ML scoring, then
   deletes the temporary S3 object (`uploads/{id}/source.zip`).

If the S3 PUT or the ingest call fails, the frontend deletes the orphaned pending record
via `DELETE /api/datasets/{id}`.

## Consequences

**Positive:**
- No file size limit imposed by Vercel — uploads are bounded only by nginx's
  `client_max_body_size 2G` and the S3 object size limit (5 TB).
- Upload progress bar still works because the browser talks directly to S3 via XHR.
- EC2 never holds the raw ZIP bytes in memory during the upload phase; it only reads
  them back from S3 when ingestion starts, one dataset at a time.

**Negative / operational:**
- S3 bucket CORS must allow `PUT` from the frontend origin. Required config:
  ```json
  [{"AllowedHeaders":["*"],"AllowedMethods":["PUT"],"AllowedOrigins":["https://peak-me.vercel.app","https://www.peakme.now"],"ExposeHeaders":[]}]
  ```
- The upload and ingestion steps are now decoupled; a crash between steps 2 and 3
  leaves a `source.zip` object in S3 under `uploads/{id}/`. These are cleaned up
  automatically on successful ingestion. Orphaned objects (from failed flows) can be
  found with `aws s3 ls s3://<bucket>/uploads/` and are small enough to ignore short-term.

## Alternatives Considered

- **Upgrade Vercel plan:** Raises the limit but doesn't eliminate it; datasets could
  still exceed the higher cap.
- **Upload directly to EC2, bypassing Vercel proxy:** Requires exposing the EC2 IP
  or domain to browsers and configuring CORS. More complex and couples the frontend
  to the backend hostname.
