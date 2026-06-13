/**
 * Cache key for a presigned S3 image URL: origin + pathname, dropping the query string.
 *
 * Presigned URLs carry a per-request signature/expiry in the query, so the SAME S3 object
 * is requested under many different URLs over time. Keying the image cache on origin+path
 * maps one object to exactly one cache entry — no duplicate growth, and an offline `<img>`
 * request resolves to the entry the download flow stored. Used by both the service worker
 * (src/sw.ts) and the download flow (download.ts) so they agree on the key.
 */
export function imageCacheKey(url: string): string {
  const u = new URL(url)
  return u.origin + u.pathname
}
