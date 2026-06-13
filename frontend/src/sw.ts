/// <reference lib="webworker" />
/**
 * PeakMe service worker (vite-plugin-pwa injectManifest).
 *
 * Deliberately conservative so it cannot harm normal online users:
 *   - Precaches the app shell (hashed assets + index.html) for offline launch.
 *   - SPA navigation fallback to index.html, EXCEPT /api (never hijack the API).
 *   - Ion/TIC/fluorescence images (our own S3 bucket only): SERVE from cache when present,
 *     otherwise pass the request straight through to the network and DO NOT cache it. So a
 *     user who never downloads keeps a permanently-empty cache and image loads fall through
 *     to the network unchanged (a read-only cache lookup, never altered, never stored). The
 *     cache is filled ONLY by the explicit "Download for offline" flow.
 *   - /api and every other request are NOT intercepted at all — they go straight to the
 *     network. /api is never cached (auth is a Bearer header, not in the URL — URL-keyed
 *     caching could serve one user's data to another on a shared device).
 *
 * This file is transpiled by vite-plugin-pwa (esbuild) and excluded from the app tsc pass.
 */
import { clientsClaim } from 'workbox-core'
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { imageCacheKey } from './lib/offline/imageKey'

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>
}

export const IMAGE_CACHE = 'peakme-images'

self.skipWaiting()
clientsClaim()
cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)

// SPA offline shell — serve index.html for navigations, but never for API paths.
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html'), { denylist: [/^\/api\//] }))

// Images: cache-match-or-passthrough, scoped to our own S3 bucket (virtual-hosted or
// path-style) so no unrelated amazonaws asset is intercepted. Never populates the cache
// itself (the download flow does, under imageCacheKey). Offline misses fail like any
// uncached image.
const BUCKET = 'peakme-ions'
registerRoute(
  ({ url }) =>
    url.hostname.endsWith('.amazonaws.com') &&
    (url.hostname.startsWith(`${BUCKET}.`) || url.pathname.startsWith(`/${BUCKET}/`)),
  async ({ request }) => {
    const cache = await caches.open(IMAGE_CACHE)
    const cached = await cache.match(imageCacheKey(request.url))
    return cached ?? fetch(request)
  },
)

// Everything else (including /api) is left untouched and goes straight to the network.
