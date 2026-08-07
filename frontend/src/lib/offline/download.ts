/**
 * "Download for offline" — pulls a slice of a dataset onto the device.
 *
 * 1. Pages the existing `/ions/queue` endpoint (strategy=all) to snapshot ion items into IDB.
 * 2. Fetches each ion image (+ TIC if requested) and the dataset's fluorescence layers,
 *    storing the bytes in the service worker's image Cache Storage keyed by the exact
 *    presigned URL — so the `<img src>` tags resolve offline with no code changes.
 *
 * We write the cache directly (not just relying on SW fetch interception) so a download
 * always populates the cache even if the SW isn't yet controlling the page.
 */
import apiClient from '../apiClient'
import type { Dataset, IonQueueItem, Project } from '../types'
import { deleteOfflineDataset, getOfflineIons, putOfflineDataset, replaceOfflineIons } from './db'
import { imageCacheKey } from './imageKey'

/** Must match the image cache name in the service worker (src/sw.ts). */
export const IMAGE_CACHE = 'peakme-images'

/** Average measured object sizes (KB) — used for the pre-download size estimate. */
export const AVG_ION_KB = 8
export const AVG_TIC_KB = 25

const FETCH_CONCURRENCY = 8
const QUEUE_PAGE = 100

export interface DownloadProgress {
  phase: 'queue' | 'images' | 'done'
  loaded: number
  total: number
}

export interface DownloadOptions {
  project: Project
  dataset: Dataset
  includeTic: boolean
  count: number
  onProgress?: (p: DownloadProgress) => void
  signal?: AbortSignal
}

async function cacheImage(cache: Cache, url: string | null): Promise<boolean> {
  if (!url) return false
  try {
    const resp = await fetch(url, { mode: 'cors' })
    if (!resp.ok) return false
    // Store under the normalized key (no presigned query) so the SW serves it offline
    // regardless of signature rotation, and one object never makes duplicate entries.
    await cache.put(imageCacheKey(url), resp.clone())
    return true
  } catch {
    return false
  }
}

/** Run `worker` over `items` with bounded concurrency, calling `tick` after each. */
async function pool<T>(items: T[], worker: (item: T) => Promise<void>, tick: () => void, signal?: AbortSignal) {
  let i = 0
  async function runner() {
    while (i < items.length) {
      if (signal?.aborted) return
      const item = items[i++]
      await worker(item)
      tick()
    }
  }
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, items.length) }, runner))
}

export async function downloadDatasetForOffline(opts: DownloadOptions): Promise<{ ions: number; failed: number }> {
  const { project, dataset, includeTic, count, onProgress, signal } = opts
  const datasetId = dataset.id

  // 1. Page the queue into a flat list of ion snapshots.
  //
  // The dialog promises the *next* N ions, so start at the first one the user hasn't
  // annotated — not at sort_order 0. Paging from -1 meant that on a half-annotated
  // dataset the entire offline copy was ions already finished; offline Resume then
  // filtered them all out and rendered "All done!" over an untouched backlog.
  //
  // Probe for the boundary, then page with strategy 'all' from there rather than
  // switching to 'unannotated_first' outright: the same snapshot also backs "Review
  // all" and "Review by label", which need annotated ions present to show anything.
  const items: IonQueueItem[] = []
  let cursor = -1
  try {
    const { data: probe } = await apiClient.get<IonQueueItem[]>(`/api/datasets/${datasetId}/ions/queue`, {
      params: { limit: 1, strategy: 'unannotated_first', after_sort_order: -1 },
    })
    // No unannotated ions left → dataset is complete; fall back to the start so a
    // download for review purposes still returns something.
    if (probe.length > 0) cursor = probe[0].sort_order - 1
  } catch {
    // Probe is an optimisation, not a requirement — fall back to paging from the start.
  }

  while (items.length < count) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
    const { data } = await apiClient.get<IonQueueItem[]>(`/api/datasets/${datasetId}/ions/queue`, {
      params: { limit: Math.min(QUEUE_PAGE, count - items.length), strategy: 'all', after_sort_order: cursor },
    })
    if (data.length === 0) break
    items.push(...data)
    cursor = data[data.length - 1].sort_order
    onProgress?.({ phase: 'queue', loaded: items.length, total: count })
    if (data.length < QUEUE_PAGE) break
  }
  // Replace (not merge) so a smaller re-download doesn't leave stale ions behind.
  await replaceOfflineIons(datasetId, items)

  // 2. Download image bytes into the SW image cache.
  const cache = await caches.open(IMAGE_CACHE)
  let failed = 0
  let done = 0
  const refImages = [dataset.fluorescence_url, dataset.fluorescence_outline_url].filter(Boolean) as string[]
  const totalImages = items.length + refImages.length

  await pool(
    items,
    async (item) => {
      const okIon = await cacheImage(cache, item.image_url)
      if (!okIon) failed++
      if (includeTic && item.tic_image_url) await cacheImage(cache, item.tic_image_url)
    },
    () => onProgress?.({ phase: 'images', loaded: ++done, total: totalImages }),
    signal,
  )
  // If the user cancelled mid-download, do NOT record the dataset as available offline
  // (the image cache is incomplete). Leave the partial cache; a later full download replaces it.
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
  for (const url of refImages) {
    await cacheImage(cache, url)
    onProgress?.({ phase: 'images', loaded: ++done, total: totalImages })
  }

  // 3. Record metadata so the rest of the app knows this dataset is available offline.
  await putOfflineDataset({
    datasetId,
    dataset,
    project,
    includeTic,
    ionCount: items.length,
    downloadedAt: Date.now(),
  })
  onProgress?.({ phase: 'done', loaded: totalImages, total: totalImages })
  return { ions: items.length, failed }
}

/** Remove a dataset's offline data: cached images + IDB snapshot. */
export async function removeDatasetOffline(datasetId: string) {
  try {
    const cache = await caches.open(IMAGE_CACHE)
    const ions = await getOfflineIons(datasetId)
    await Promise.all(
      ions.flatMap((i) =>
        [i.image_url, i.tic_image_url]
          .filter(Boolean)
          .map((u) => cache.delete(imageCacheKey(u as string))),
      ),
    )
  } catch {
    /* cache may be unavailable; metadata removal below still runs */
  }
  await deleteOfflineDataset(datasetId)
}
