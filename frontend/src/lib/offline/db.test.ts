import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import type { IonQueueItem } from '../types'

// Fresh DB + fresh module (db.ts caches a connection singleton) for each test.
let db: typeof import('./db')

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory()
  vi.resetModules()
  db = await import('./db')
})

function ion(id: string, sort_order: number, over: Partial<IonQueueItem> = {}): IonQueueItem {
  return {
    id,
    mz_value: 100 + sort_order,
    sort_order,
    image_url: `https://x/${id}.png`,
    tic_image_url: null,
    is_starred: false,
    annotation: null,
    ...over,
  }
}

describe('replaceOfflineIons', () => {
  it('atomically replaces the snapshot — a smaller re-download leaves no stale ions', async () => {
    await db.replaceOfflineIons('d1', [ion('a', 0), ion('b', 1), ion('c', 2)])
    await db.replaceOfflineIons('d1', [ion('a', 0)]) // smaller slice

    const got = await db.getOfflineIons('d1')
    expect(got.map((i) => i.id)).toEqual(['a'])
  })

  it('isolates snapshots per dataset', async () => {
    await db.replaceOfflineIons('d1', [ion('a', 0)])
    await db.replaceOfflineIons('d2', [ion('x', 0), ion('y', 1)])
    expect((await db.getOfflineIons('d1')).map((i) => i.id)).toEqual(['a'])
    expect((await db.getOfflineIons('d2')).map((i) => i.id)).toEqual(['x', 'y'])
  })
})

describe('fetchOfflineBatch', () => {
  const seed = () =>
    db.replaceOfflineIons('d1', [
      ion('a', 0, { annotation: { label_option_id: 'l1', label_name: 'Tumor', confidence: null } }),
      ion('b', 1), // unannotated
      ion('c', 2, { is_starred: true }),
      ion('d', 3, { annotation: { label_option_id: 'l2', label_name: 'Necrosis', confidence: null } }),
      ion('e', 4, { is_starred: true }),
    ])

  it('unannotated_first returns only ions without an annotation, in sort_order', async () => {
    await seed()
    const batch = await db.fetchOfflineBatch('d1', {
      strategy: 'unannotated_first',
      afterSortOrder: -1,
      limit: 100,
    })
    expect(batch.map((i) => i.id)).toEqual(['b', 'c', 'e'])
  })

  it('starred_first returns only starred ions', async () => {
    await seed()
    const batch = await db.fetchOfflineBatch('d1', {
      strategy: 'starred_first',
      afterSortOrder: -1,
      limit: 100,
    })
    expect(batch.map((i) => i.id)).toEqual(['c', 'e'])
  })

  it('labelFilter overrides the strategy (matches the backend queue precedence)', async () => {
    await seed()
    const batch = await db.fetchOfflineBatch('d1', {
      strategy: 'unannotated_first', // ignored when labelFilter is set
      labelFilter: 'Tumor',
      afterSortOrder: -1,
      limit: 100,
    })
    expect(batch.map((i) => i.id)).toEqual(['a'])
  })

  it('paginates with the afterSortOrder cursor and limit — no overlap, no gap', async () => {
    await seed()
    const opts = { strategy: 'all' as const, afterSortOrder: -1, limit: 2 }
    const page1 = await db.fetchOfflineBatch('d1', opts)
    expect(page1.map((i) => i.id)).toEqual(['a', 'b'])

    const page2 = await db.fetchOfflineBatch('d1', {
      ...opts,
      afterSortOrder: page1[page1.length - 1].sort_order,
    })
    expect(page2.map((i) => i.id)).toEqual(['c', 'd'])

    const page3 = await db.fetchOfflineBatch('d1', {
      ...opts,
      afterSortOrder: page2[page2.length - 1].sort_order,
    })
    expect(page3.map((i) => i.id)).toEqual(['e']) // short final page = exhausted
  })
})

describe('pending mutations', () => {
  it('getAllPending returns insertion order (by autoincrement id)', async () => {
    await db.addPending({ datasetId: 'd1', ionId: 'i1', type: 'annotate', clientTs: 1 })
    await db.addPending({ datasetId: 'd1', ionId: 'i2', type: 'star', desiredStar: true, clientTs: 2 })
    await db.addPending({ datasetId: 'd1', ionId: 'i3', type: 'unannotate', clientTs: 3 })

    const all = await db.getAllPending()
    expect(all.map((p) => p.ionId)).toEqual(['i1', 'i2', 'i3'])
  })

  it('removePendingByIon collapses only the named types for one ion', async () => {
    await db.addPending({ datasetId: 'd1', ionId: 'i1', type: 'annotate', clientTs: 1 })
    await db.addPending({ datasetId: 'd1', ionId: 'i1', type: 'star', desiredStar: true, clientTs: 2 })
    await db.addPending({ datasetId: 'd1', ionId: 'i2', type: 'annotate', clientTs: 3 })

    await db.removePendingByIon('d1', 'i1', ['annotate', 'unannotate'])

    expect((await db.getPendingByIon('d1', 'i1')).map((p) => p.type)).toEqual(['star']) // star kept
    expect((await db.getPendingByIon('d1', 'i2')).map((p) => p.type)).toEqual(['annotate']) // other ion untouched
  })
})
