# ADR-012: Offline annotation via an installable PWA

**Date:** 2026-06-13
**Status:** Accepted

## Context

Researchers need to annotate ion images where connectivity is poor or absent (field sites, flights, shielded lab rooms). Measured usage supports this being practical: a typical dataset is ~7k ions, a real annotation sitting is ~580 ions (p95 ~2,900), and measured S3 object sizes are ~5–11 KB per ion image and ~25 KB per TIC plot. So a ~3,000-ion offline budget — covering 95% of sittings — is ~15 MB without TIC and ~110 MB with, well within an installed iOS PWA's storage.

The frontend is a React/Vite SPA with no prior offline infrastructure. Annotations are already idempotent server-side (`(ion_id, user_id)` upsert, see ADR-005), which makes offline replay safe.

## Decision

Ship an **installable PWA** (not a native app) — it reuses the existing swipe/keyboard annotation UI verbatim. Implemented with `vite-plugin-pwa` (Workbox, `registerType: 'autoUpdate'`).

- **Explicit "Download for offline"** action per dataset (presets + optional TIC toggle + size estimate), plus transparent runtime caching of viewed images. Predictable, and it works *before* going offline.
- **Service worker** is a hand-written Workbox SW via `injectManifest` (`src/sw.ts`), chosen over declarative `generateSW` so it can be deliberately conservative for non-offline users (see below). It precaches the app shell and provides the SPA navigation fallback (excluding `/api`).
- **Image bytes** live in the SW's Cache Storage (`peakme-images`), keyed by the **normalized URL** (`origin + pathname`, dropping the presigned query string) so one S3 object maps to exactly one entry. The image route is **serve-only**: it returns a cached match or passes the request through to the network **without caching** — so a user who never downloads is never bloated with image bytes. The cache is populated **only** by the explicit "Download for offline" flow (which fetches via CORS and writes under the same normalized key). `<img>` tags are unchanged.
- **App API (`/api/*`) is NOT cached by the SW.** Auth is a Bearer header (not in the URL), so URL-keyed caching could serve one user's data to another on a shared device; and stale API reads are risky. API requests pass straight through to the network. Project/dataset metadata needed offline comes from the **IndexedDB snapshot** instead (the annotation queries fall back to it on a network error).
- **Annotation data** (dataset/project/label snapshots, the downloaded ion queue, and a pending-mutation log) lives in IndexedDB (`idb`). The annotation queue is reconstructed offline from the snapshot, mirroring the server's queue ordering.
- **Mutations** (annotate / unannotate / star) go through an offline-aware wrapper: when **online it behaves exactly like the original direct call** (errors propagate, nothing is queued); only when `navigator.onLine === false` does it queue the action and update the snapshot optimistically. A reconciler replays the queue on reconnect/foreground (serialized across tabs with a Web Lock). Stars store a *desired* state and converge (the server endpoint is a toggle); undo always drives the server to "no annotation".
- **Install UX** is platform-aware: capture `beforeinstallprompt` for a real install button on Chromium (Android/desktop); show guided "Add to Home Screen / Add to Dock" steps on iOS/macOS Safari, which expose no install API.

## Consequences

**Positive:**
- One codebase; the annotation UI is unchanged. No DB schema change; backend changes are deferred and optional.
- Offline replay is safe (idempotent upsert). The precious data (unsynced mutations) is tiny (<1 MB); cached images are disposable and re-downloadable, so storage eviction never loses annotations.

**Negative / trade-offs:**
- Requires a CORS `GET` rule on the `peakme-ions` bucket for the app origins (to fetch image bytes). One-time, additive infra change — see `docs/deployment.md`.
- A service worker can serve stale assets if mismanaged; mitigated by `registerType: 'autoUpdate'`, hashed-asset precaching with revisions, and the conservative routing above (no transparent caching, no `/api` caching).
- iOS has no background sync — syncing happens on app open/foreground, not in the background.
- Conflicts are last-write-wins per `(ion_id, user_id)`; the queue is refreshed from the server after sync.

## Alternatives Considered

- **Native iOS/Android app:** rebuilds the entire annotation UI and adds App Store overhead for no functional gain here. Rejected.
- **Declarative `generateSW` with `NetworkFirst` `/api` caching:** simpler, but cannot express a custom cache key (so presigned-URL rotation bloats the image cache) and URL-keyed `/api` caching risks cross-user data exposure on shared devices. Replaced by the `injectManifest` SW above.
- **Hand-managed IndexedDB image blobs + `resolveImageSrc`:** more app code and re-render complexity, and touches every `<img>`. Superseded by the SW image cache keyed on the normalized URL.
- **Batch sync endpoint + `image_key` in the queue response:** useful at scale but not required for the MVP (per-mutation replay against existing endpoints works). Deferred to a Phase 2.
