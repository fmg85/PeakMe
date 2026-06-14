import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'

// Real IndexedDB (fake-indexeddb) so we exercise the actual queue collapse/supersede
// logic; only the network + auth layers are mocked.
vi.mock('../apiClient', () => ({
  default: { post: vi.fn().mockResolvedValue({ data: { starred: true } }), delete: vi.fn().mockResolvedValue({}) },
}))
vi.mock('../supabaseClient', () => ({
  supabase: { auth: { onAuthStateChange: vi.fn(), getSession: vi.fn() } },
}))

let db: typeof import('./db')
let mutations: typeof import('./mutations')
let post: any

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory()
  vi.clearAllMocks()
  vi.stubGlobal('navigator', { onLine: false }) // default: offline (queueing path)
  vi.resetModules()
  db = await import('./db')
  mutations = await import('./mutations')
  const api = (await import('../apiClient')).default as any
  post = api.post
  post.mockResolvedValue({ data: { starred: true } })
})

afterEach(() => vi.unstubAllGlobals())

describe('offline queueing + collapse', () => {
  it('collapses repeated offline annotations of one ion to a single row (latest wins)', async () => {
    await mutations.annotateIon('d1', 'i1', 'l1', 'Tumor')
    await mutations.annotateIon('d1', 'i1', 'l2', 'Necrosis')

    const pend = await db.getPendingByIon('d1', 'i1')
    const annotates = pend.filter((p) => p.type === 'annotate')
    expect(annotates).toHaveLength(1)
    expect(annotates[0].labelOptionId).toBe('l2')
  })

  it('offline annotate then undo nets a single unannotate (so a prior synced label is removed)', async () => {
    await mutations.annotateIon('d1', 'i1', 'l1', 'Tumor')
    await mutations.unannotateIon('d1', 'i1')

    const pend = await db.getPendingByIon('d1', 'i1')
    expect(pend.map((p) => p.type)).toEqual(['unannotate'])
  })

  it('offline toggleStar records the desired state and returns it', async () => {
    const result = await mutations.toggleStarIon('d1', 'i1', false) // currently unstarred → desire starred

    expect(result).toBe(true)
    const pend = await db.getPendingByIon('d1', 'i1')
    expect(pend.map((p) => p.type)).toEqual(['star'])
    expect(pend[0].desiredStar).toBe(true)
  })

  it('does not touch the network while offline', async () => {
    await mutations.annotateIon('d1', 'i1', 'l1', 'Tumor')
    expect(post).not.toHaveBeenCalled()
  })
})

describe('online writes supersede the queue', () => {
  it('online annotate calls the API and clears any queued annotate/unannotate for that ion', async () => {
    // Pre-seed a stale offline annotation in the queue.
    await db.addPending({ datasetId: 'd1', ionId: 'i1', type: 'annotate', labelOptionId: 'old', clientTs: 0 })
    vi.stubGlobal('navigator', { onLine: true })

    await mutations.annotateIon('d1', 'i1', 'l1', 'Tumor')

    expect(post).toHaveBeenCalledWith('/api/ions/i1/annotate', { label_option_id: 'l1' })
    expect(await db.getPendingByIon('d1', 'i1')).toHaveLength(0) // stale queued mutation superseded
  })

  it('propagates an online annotate error (card resets) instead of silently queueing', async () => {
    vi.stubGlobal('navigator', { onLine: true })
    post.mockRejectedValueOnce({ response: { status: 500 } })

    await expect(mutations.annotateIon('d1', 'i1', 'l1', 'Tumor')).rejects.toBeTruthy()
    // Nothing queued — online failures surface to the caller, they are not turned into pending writes.
    expect(await db.getPendingByIon('d1', 'i1')).toHaveLength(0)
  })
})
