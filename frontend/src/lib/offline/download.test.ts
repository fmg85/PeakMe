import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { IonQueueItem } from '../types'

vi.mock('../apiClient', () => ({ default: { get: vi.fn() } }))
vi.mock('./db', () => ({
  replaceOfflineIons: vi.fn(),
  putOfflineDataset: vi.fn(),
  deleteOfflineDataset: vi.fn(),
  getOfflineIons: vi.fn(async () => []),
}))

let download: typeof import('./download')
let db: typeof import('./db')
let get: ReturnType<typeof vi.fn>

const ion = (sortOrder: number, annotated = false): IonQueueItem => ({
  id: `i${sortOrder}`,
  mz_value: 100 + sortOrder,
  sort_order: sortOrder,
  image_url: `https://s3/img/${sortOrder}.png`,
  tic_image_url: null,
  is_starred: false,
  annotation: annotated
    ? { label_option_id: 'l1', label_name: 'Tumor', confidence: null }
    : null,
})

const opts = (count: number) => ({
  project: { id: 'p1' } as never,
  dataset: { id: 'd1', fluorescence_url: null, fluorescence_outline_url: null } as never,
  includeTic: false,
  count,
})

beforeEach(async () => {
  vi.clearAllMocks()
  vi.resetModules()
  // Cache Storage isn't available in the node test env; the image phase is not
  // what these tests are about.
  vi.stubGlobal('caches', { open: async () => ({ put: async () => {}, match: async () => undefined }) })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, blob: async () => new Blob() })))
  download = await import('./download')
  db = await import('./db')
  get = (await import('../apiClient')).default.get as ReturnType<typeof vi.fn>
})

describe('downloadDatasetForOffline — "Next N" starts at the first unannotated ion', () => {
  it('probes for the unannotated boundary and pages from there', async () => {
    // Ions 0..4999 are already annotated; the next unannotated one is 5000.
    get.mockImplementation(async (_url: string, cfg: { params: Record<string, unknown> }) => {
      const p = cfg.params
      if (p.strategy === 'unannotated_first') return { data: [ion(5000)] }
      const after = p.after_sort_order as number
      return { data: [ion(after + 1), ion(after + 2)] }
    })

    await download.downloadDatasetForOffline(opts(2))

    const probe = get.mock.calls[0][1].params
    expect(probe).toMatchObject({ strategy: 'unannotated_first', limit: 1, after_sort_order: -1 })

    // The first real page must resume just below the boundary, not at -1.
    const firstPage = get.mock.calls[1][1].params
    expect(firstPage.strategy).toBe('all')
    expect(firstPage.after_sort_order).toBe(4999)

    const stored = vi.mocked(db.replaceOfflineIons).mock.calls[0][1] as IonQueueItem[]
    expect(stored.map((i) => i.sort_order)).toEqual([5000, 5001])
  })

  it('falls back to the start when nothing is unannotated (review download)', async () => {
    get.mockImplementation(async (_url: string, cfg: { params: Record<string, unknown> }) => {
      if (cfg.params.strategy === 'unannotated_first') return { data: [] }
      return { data: [ion(0, true), ion(1, true)] }
    })

    await download.downloadDatasetForOffline(opts(2))

    expect(get.mock.calls[1][1].params.after_sort_order).toBe(-1)
    const stored = vi.mocked(db.replaceOfflineIons).mock.calls[0][1] as IonQueueItem[]
    expect(stored.map((i) => i.sort_order)).toEqual([0, 1])
  })

  it('still downloads if the probe request fails', async () => {
    get.mockImplementation(async (_url: string, cfg: { params: Record<string, unknown> }) => {
      if (cfg.params.strategy === 'unannotated_first') throw { code: 'ERR_NETWORK' }
      return { data: [ion(0), ion(1)] }
    })

    await download.downloadDatasetForOffline(opts(2))

    expect(db.replaceOfflineIons).toHaveBeenCalled()
    expect(get.mock.calls[1][1].params.after_sort_order).toBe(-1)
  })

  it('keeps paging with strategy "all" so Review-all / by-label still have data', async () => {
    // The snapshot must contain annotated ions too — switching the download itself to
    // unannotated_first would leave those review modes with an empty local dataset.
    get.mockImplementation(async (_url: string, cfg: { params: Record<string, unknown> }) => {
      if (cfg.params.strategy === 'unannotated_first') return { data: [ion(10)] }
      return { data: [ion(10), ion(11, true)] }
    })

    await download.downloadDatasetForOffline(opts(2))

    const stored = vi.mocked(db.replaceOfflineIons).mock.calls[0][1] as IonQueueItem[]
    expect(stored.some((i) => i.annotation !== null)).toBe(true)
  })
})
