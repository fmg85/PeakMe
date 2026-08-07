import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PendingMutation } from './db'

// Mock the data + network layers so we can drive the reconciler deterministically.
vi.mock('../apiClient', () => ({ default: { post: vi.fn(), delete: vi.fn() } }))
vi.mock('../supabaseClient', () => ({
  supabase: { auth: { onAuthStateChange: vi.fn(), getSession: vi.fn() } },
}))
// isOwnedBy is pure ownership policy — use the REAL implementation so these tests
// exercise it rather than a stub that would hide a regression in it.
vi.mock('./db', async () => {
  const actual = await vi.importActual<typeof import('./db')>('./db')
  return {
    getAllPending: vi.fn(),
    getPendingById: vi.fn(),
    deletePending: vi.fn(),
    countPending: vi.fn(),
    isOwnedBy: actual.isOwnedBy,
  }
})

let sync: typeof import('./sync')
let db: typeof import('./db')
let post: any

const annotate = (id: number): PendingMutation => ({
  id,
  datasetId: 'd1',
  ionId: `i${id}`,
  type: 'annotate',
  labelOptionId: `l${id}`,
  clientTs: 0,
})

const unannotate = (id: number): PendingMutation => ({
  id,
  datasetId: 'd1',
  ionId: `i${id}`,
  type: 'unannotate',
  clientTs: 0,
})

beforeEach(async () => {
  vi.clearAllMocks()
  vi.stubGlobal('navigator', { onLine: true }) // no navigator.locks → doFlush runs directly
  vi.resetModules()
  sync = await import('./sync')
  db = await import('./db')
  const api = (await import('../apiClient')).default as any
  post = api.post
  // sensible defaults
  const { supabase } = await import('../supabaseClient')
  vi.mocked(supabase.auth.getSession).mockResolvedValue({ data: { session: null } } as any)
  vi.mocked(db.deletePending).mockResolvedValue(undefined as any)
  vi.mocked(db.countPending).mockResolvedValue(0)
  // by default a re-read finds the row (i.e. not superseded)
  vi.mocked(db.getPendingById).mockImplementation(async (id) => annotate(id))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('doFlush (offline replay reconciler)', () => {
  it('deletes a queued mutation only after the server confirms (2xx)', async () => {
    vi.mocked(db.getAllPending).mockResolvedValue([annotate(1)])
    post.mockResolvedValue({ data: {} })

    await sync.flushPendingMutations()

    expect(post).toHaveBeenCalledWith('/api/ions/i1/annotate', { label_option_id: 'l1' })
    expect(db.deletePending).toHaveBeenCalledWith(1)
  })

  it('drops a mutation whose target 404s (ion/label gone)', async () => {
    vi.mocked(db.getAllPending).mockResolvedValue([annotate(1)])
    post.mockRejectedValue({ response: { status: 404 } })

    await sync.flushPendingMutations()

    expect(db.deletePending).toHaveBeenCalledWith(1) // dropped, not retried forever
  })

  it('parks the queue on 401 without dropping anything', async () => {
    vi.mocked(db.getAllPending).mockResolvedValue([annotate(1), annotate(2)])
    post.mockRejectedValue({ response: { status: 401 } })

    await sync.flushPendingMutations()

    expect(db.deletePending).not.toHaveBeenCalled()
    expect(sync.getSyncState().lastError).toBe('Sign in to finish syncing')
  })

  it('stops and keeps the queue when the connection drops mid-flush', async () => {
    vi.mocked(db.getAllPending).mockResolvedValue([annotate(1), annotate(2)])
    post.mockRejectedValue({ code: 'ERR_NETWORK' })

    await sync.flushPendingMutations()

    expect(db.deletePending).not.toHaveBeenCalled()
    expect(sync.getSyncState().online).toBe(false)
  })

  it('skips a row that was superseded (deleted) since the snapshot was read', async () => {
    vi.mocked(db.getAllPending).mockResolvedValue([annotate(1)])
    vi.mocked(db.getPendingById).mockResolvedValue(undefined) // re-read finds it gone

    await sync.flushPendingMutations()

    expect(post).not.toHaveBeenCalled()
    expect(db.deletePending).not.toHaveBeenCalled()
  })

  it('converges a star toggle to the desired state, retrying once, then deletes', async () => {
    const star: PendingMutation = {
      id: 1,
      datasetId: 'd1',
      ionId: 'i1',
      type: 'star',
      desiredStar: true,
      clientTs: 0,
    }
    vi.mocked(db.getAllPending).mockResolvedValue([star])
    vi.mocked(db.getPendingById).mockResolvedValue(star)
    // First toggle lands on the wrong state; second corrects it.
    post
      .mockResolvedValueOnce({ data: { starred: false } })
      .mockResolvedValueOnce({ data: { starred: true } })

    await sync.flushPendingMutations()

    expect(post).toHaveBeenCalledTimes(2)
    expect(db.deletePending).toHaveBeenCalledWith(1)
  })

  it('leaves a star queued if it never reaches the desired state', async () => {
    const star: PendingMutation = {
      id: 1,
      datasetId: 'd1',
      ionId: 'i1',
      type: 'star',
      desiredStar: true,
      clientTs: 0,
    }
    vi.mocked(db.getAllPending).mockResolvedValue([star])
    vi.mocked(db.getPendingById).mockResolvedValue(star)
    post.mockResolvedValue({ data: { starred: false } }) // never converges

    await sync.flushPendingMutations()

    expect(post).toHaveBeenCalledTimes(2)
    expect(db.deletePending).not.toHaveBeenCalled()
  })

  it('stops the pass and requeues on an unexpected 5xx (scheduling a retry)', async () => {
    vi.useFakeTimers()
    vi.mocked(db.getAllPending).mockResolvedValue([annotate(1), annotate(2)])
    post.mockRejectedValue({ response: { status: 500 } })

    await sync.flushPendingMutations()

    expect(post).toHaveBeenCalledTimes(1) // broke after the first failure, didn't hammer the rest
    expect(db.deletePending).not.toHaveBeenCalled()
    expect(sync.getSyncState().lastError).toBe('Sync error — will retry')
  })

  it('does nothing when offline', async () => {
    vi.stubGlobal('navigator', { onLine: false })
    vi.mocked(db.getAllPending).mockResolvedValue([annotate(1)])

    await sync.flushPendingMutations()

    expect(db.getAllPending).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
  })
})

describe('unannotate replay (undo must survive a failed flush)', () => {
  it('keeps a queued undo when the DELETE fails with a network error', async () => {
    // Regression: the network error used to be swallowed, so execution fell through
    // to deletePending() and the undo was erased while the server kept the annotation.
    vi.mocked(db.getAllPending).mockResolvedValue([unannotate(1)])
    vi.mocked(db.getPendingById).mockImplementation(async (id) => unannotate(id))
    const api = (await import('../apiClient')).default as any
    api.delete.mockRejectedValue({ code: 'ERR_NETWORK' })

    await sync.flushPendingMutations()

    expect(db.deletePending).not.toHaveBeenCalled()
    expect(sync.getSyncState().online).toBe(false)
  })

  it('keeps a queued undo when the DELETE times out', async () => {
    vi.mocked(db.getAllPending).mockResolvedValue([unannotate(1)])
    vi.mocked(db.getPendingById).mockImplementation(async (id) => unannotate(id))
    const api = (await import('../apiClient')).default as any
    api.delete.mockRejectedValue({ code: 'ECONNABORTED' })

    await sync.flushPendingMutations()

    expect(db.deletePending).not.toHaveBeenCalled()
  })

  it('stops the pass so later mutations are not skipped', async () => {
    vi.mocked(db.getAllPending).mockResolvedValue([unannotate(1), unannotate(2)])
    vi.mocked(db.getPendingById).mockImplementation(async (id) => unannotate(id))
    const api = (await import('../apiClient')).default as any
    api.delete.mockRejectedValue({ code: 'ERR_NETWORK' })

    await sync.flushPendingMutations()

    expect(api.delete).toHaveBeenCalledTimes(1)
    expect(db.deletePending).not.toHaveBeenCalled()
  })

  it('still drops the undo on a genuine 404 (already absent on the server)', async () => {
    vi.mocked(db.getAllPending).mockResolvedValue([unannotate(1)])
    vi.mocked(db.getPendingById).mockImplementation(async (id) => unannotate(id))
    const api = (await import('../apiClient')).default as any
    api.delete.mockRejectedValue({ response: { status: 404 } })

    await sync.flushPendingMutations()

    expect(db.deletePending).toHaveBeenCalledWith(1)
  })

  it('deletes the undo after a successful DELETE', async () => {
    vi.mocked(db.getAllPending).mockResolvedValue([unannotate(1)])
    vi.mocked(db.getPendingById).mockImplementation(async (id) => unannotate(id))
    const api = (await import('../apiClient')).default as any
    api.delete.mockResolvedValue({ data: {} })

    await sync.flushPendingMutations()

    expect(api.delete).toHaveBeenCalledWith('/api/ions/i1/annotate')
    expect(db.deletePending).toHaveBeenCalledWith(1)
  })
})

describe('per-user scoping of the offline queue (multi-user groundwork)', () => {
  const owned = (id: number, userId?: string): PendingMutation => ({
    ...annotate(id), userId,
  })
  const signedInAs = async (id: string | null) => {
    const { supabase } = await import('../supabaseClient')
    vi.mocked(supabase.auth.getSession).mockResolvedValue(
      { data: { session: id ? { user: { id } } : null } } as any)
  }

  it('replays only the signed-in user\'s mutations', async () => {
    await signedInAs('userA')
    vi.mocked(db.getAllPending).mockResolvedValue([owned(1, 'userA'), owned(2, 'userB')])
    vi.mocked(db.getPendingById).mockImplementation(async (id) => owned(id, id === 1 ? 'userA' : 'userB'))
    post.mockResolvedValue({ data: {} })

    await sync.flushPendingMutations()

    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith('/api/ions/i1/annotate', { label_option_id: 'l1' })
  })

  it('never deletes another user\'s queued mutation', async () => {
    // The whole point: B's work must survive until B signs back in.
    await signedInAs('userA')
    vi.mocked(db.getAllPending).mockResolvedValue([owned(2, 'userB')])
    vi.mocked(db.getPendingById).mockImplementation(async (id) => owned(id, 'userB'))
    post.mockResolvedValue({ data: {} })

    await sync.flushPendingMutations()

    expect(post).not.toHaveBeenCalled()
    expect(db.deletePending).not.toHaveBeenCalled()
  })

  it('adopts legacy rows that predate user stamping', async () => {
    // Rows already on disk have userId === undefined and must not be stranded forever.
    await signedInAs('userA')
    vi.mocked(db.getAllPending).mockResolvedValue([owned(1, undefined)])
    vi.mocked(db.getPendingById).mockImplementation(async (id) => owned(id, undefined))
    post.mockResolvedValue({ data: {} })

    await sync.flushPendingMutations()

    expect(post).toHaveBeenCalledTimes(1)
    expect(db.deletePending).toHaveBeenCalledWith(1)
  })

  it('does not claim attributed rows while signed out', async () => {
    await signedInAs(null)
    vi.mocked(db.getAllPending).mockResolvedValue([owned(1, 'userA'), owned(2, undefined)])
    vi.mocked(db.getPendingById).mockImplementation(async (id) => owned(id, id === 1 ? 'userA' : undefined))
    post.mockResolvedValue({ data: {} })

    await sync.flushPendingMutations()

    // Only the unattributed one replays; the attributed one waits for its owner.
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith('/api/ions/i2/annotate', { label_option_id: 'l2' })
    expect(db.deletePending).not.toHaveBeenCalledWith(1)
  })
})

describe('isNetworkError', () => {
  it('treats connection failures as retryable but real HTTP responses as not', async () => {
    await import('./sync') // ensure module loaded
    expect(sync.isNetworkError({ code: 'ERR_NETWORK' })).toBe(true)
    expect(sync.isNetworkError({ code: 'ECONNABORTED' })).toBe(true)
    expect(sync.isNetworkError({})).toBe(true) // no response → offline-ish
    expect(sync.isNetworkError({ code: 'ERR_CANCELED' })).toBe(false) // deliberate abort
    expect(sync.isNetworkError({ response: { status: 500 } })).toBe(false)
  })
})
