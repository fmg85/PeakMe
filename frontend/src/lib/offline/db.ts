/**
 * Offline persistence (IndexedDB via `idb`).
 *
 * Stores the *data* needed to annotate offline:
 *   - offlineDatasets : metadata snapshot per downloaded dataset (dataset + project + labels)
 *   - offlineIons     : the downloaded ion queue items (with their presigned image URLs)
 *   - pendingMutations: annotate / unannotate / star actions made while offline, replayed on reconnect
 *
 * Image *bytes* are NOT stored here — they live in the service worker's Cache Storage
 * (keyed by the exact presigned URL we stored in offlineIons), so `<img>` tags work
 * offline unchanged. See ADR-005.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Dataset, IonQueueItem, Project } from '../types'

export interface OfflineDatasetMeta {
  datasetId: string
  dataset: Dataset
  project: Project
  includeTic: boolean
  ionCount: number
  downloadedAt: number
}

export interface OfflineIon extends IonQueueItem {
  datasetId: string
}

export type PendingType = 'annotate' | 'unannotate' | 'star'

export interface PendingMutation {
  id?: number
  datasetId: string
  ionId: string
  type: PendingType
  labelOptionId?: string
  labelName?: string
  desiredStar?: boolean
  clientTs: number
  /**
   * Supabase user id of whoever queued this. Optional on purpose: rows written before
   * this existed have it `undefined`, and those are treated as adoptable by whoever is
   * signed in (they can only have come from that person on this device). Deliberately
   * NOT added as an index, so no DB_VERSION bump is required — see the note on
   * `upgrade` below for why bumping the version is dangerous here.
   */
  userId?: string
}

interface PeakMeDB extends DBSchema {
  offlineDatasets: { key: string; value: OfflineDatasetMeta }
  offlineIons: {
    key: [string, string]
    value: OfflineIon
    indexes: { 'by-dataset': string }
  }
  pendingMutations: {
    key: number
    value: PendingMutation
    indexes: { 'by-dataset': string }
  }
}

const DB_NAME = 'peakme-offline'
const DB_VERSION = 1

let dbPromise: Promise<IDBPDatabase<PeakMeDB>> | null = null

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<PeakMeDB>(DB_NAME, DB_VERSION, {
      // Guarded so this is safe to re-run. `upgrade` fires for EVERY version bump, not
      // just first install, so the original unconditional createObjectStore calls would
      // have thrown ConstraintError on every existing client the moment DB_VERSION was
      // raised — wiping their queued offline annotations. Keep every branch guarded.
      upgrade(db) {
        if (!db.objectStoreNames.contains('offlineDatasets')) {
          db.createObjectStore('offlineDatasets', { keyPath: 'datasetId' })
        }
        if (!db.objectStoreNames.contains('offlineIons')) {
          const ions = db.createObjectStore('offlineIons', { keyPath: ['datasetId', 'id'] })
          ions.createIndex('by-dataset', 'datasetId')
        }
        if (!db.objectStoreNames.contains('pendingMutations')) {
          const pending = db.createObjectStore('pendingMutations', { keyPath: 'id', autoIncrement: true })
          pending.createIndex('by-dataset', 'datasetId')
        }
      },
    })
  }
  return dbPromise
}

// ─── Dataset metadata ─────────────────────────────────────────────────────────

export async function putOfflineDataset(meta: OfflineDatasetMeta) {
  return (await getDB()).put('offlineDatasets', meta)
}

export async function getOfflineDataset(datasetId: string): Promise<OfflineDatasetMeta | undefined> {
  return (await getDB()).get('offlineDatasets', datasetId)
}

export async function getAllOfflineDatasets(): Promise<OfflineDatasetMeta[]> {
  return (await getDB()).getAll('offlineDatasets')
}

export async function deleteOfflineDataset(datasetId: string) {
  const db = await getDB()
  const ionKeys = await db.getAllKeysFromIndex('offlineIons', 'by-dataset', datasetId)
  const tx = db.transaction(['offlineDatasets', 'offlineIons'], 'readwrite')
  await Promise.all([
    tx.objectStore('offlineDatasets').delete(datasetId),
    ...ionKeys.map((k) => tx.objectStore('offlineIons').delete(k)),
  ])
  await tx.done
}

// ─── Ion queue snapshots ────────────────────────────────────────────────────

export async function putOfflineIons(datasetId: string, items: IonQueueItem[]) {
  const db = await getDB()
  const tx = db.transaction('offlineIons', 'readwrite')
  await Promise.all(items.map((item) => tx.store.put({ ...item, datasetId })))
  await tx.done
}

/**
 * Replace a dataset's ion snapshot atomically: delete the old set, then write the new one
 * in a single transaction. Prevents stale ions from lingering when a smaller slice is
 * re-downloaded (which would otherwise corrupt the offline queue).
 */
export async function replaceOfflineIons(datasetId: string, items: IonQueueItem[]) {
  const db = await getDB()
  const tx = db.transaction('offlineIons', 'readwrite')
  const oldKeys = await tx.store.index('by-dataset').getAllKeys(datasetId)
  await Promise.all(oldKeys.map((k) => tx.store.delete(k)))
  await Promise.all(items.map((item) => tx.store.put({ ...item, datasetId })))
  await tx.done
}

export async function getOfflineIons(datasetId: string): Promise<OfflineIon[]> {
  const db = await getDB()
  const items = await db.getAllFromIndex('offlineIons', 'by-dataset', datasetId)
  return items.sort((a, b) => a.sort_order - b.sort_order)
}

export async function updateOfflineIon(
  datasetId: string,
  ionId: string,
  updater: (item: OfflineIon) => OfflineIon,
) {
  const db = await getDB()
  const existing = await db.get('offlineIons', [datasetId, ionId])
  if (existing) await db.put('offlineIons', updater(existing))
}

interface OfflineBatchOpts {
  strategy: 'unannotated_first' | 'starred_first' | 'all'
  labelFilter?: string | null
  afterSortOrder: number
  limit: number
}

/**
 * Reproduce the server's `/ions/queue` ordering against the local snapshot, so the
 * annotation flow behaves the same offline. Cursor is the `sort_order` of the last item.
 */
export async function fetchOfflineBatch(datasetId: string, opts: OfflineBatchOpts): Promise<IonQueueItem[]> {
  const { strategy, labelFilter, afterSortOrder, limit } = opts
  let items = await getOfflineIons(datasetId)
  if (labelFilter) {
    items = items.filter((i) => i.annotation?.label_name === labelFilter)
  } else if (strategy === 'unannotated_first') {
    items = items.filter((i) => !i.annotation)
  } else if (strategy === 'starred_first') {
    items = items.filter((i) => i.is_starred)
  }
  return items.filter((i) => i.sort_order > afterSortOrder).slice(0, limit)
}

// ─── Pending mutations ────────────────────────────────────────────────────────

export async function addPending(m: PendingMutation) {
  return (await getDB()).add('pendingMutations', m)
}

export async function getAllPending(): Promise<PendingMutation[]> {
  const all = await (await getDB()).getAll('pendingMutations')
  return all.sort((a, b) => (a.id ?? 0) - (b.id ?? 0))
}

export async function getPendingById(id: number): Promise<PendingMutation | undefined> {
  return (await getDB()).get('pendingMutations', id)
}

export async function getPendingByIon(datasetId: string, ionId: string): Promise<PendingMutation[]> {
  const all = await (await getDB()).getAllFromIndex('pendingMutations', 'by-dataset', datasetId)
  return all.filter((m) => m.ionId === ionId)
}

export async function deletePending(id: number) {
  return (await getDB()).delete('pendingMutations', id)
}

/** Drop existing pending mutations of the given types for an ion (collapse repeated edits). */
export async function removePendingByIon(datasetId: string, ionId: string, types: PendingType[]) {
  const pendings = await getPendingByIon(datasetId, ionId)
  await Promise.all(
    pendings.filter((p) => types.includes(p.type) && p.id != null).map((p) => deletePending(p.id!)),
  )
}

export async function countPending(userId?: string): Promise<number> {
  const all = await getAllPending()
  return all.filter((m) => isOwnedBy(m, userId)).length
}

/**
 * True if `m` belongs to `userId` (or is legacy/unattributed and so adoptable).
 *
 * Never used to DELETE a mutation — only to decide whether to replay or skip it. A row
 * stamped with a different user must survive untouched until that user signs back in,
 * otherwise switching accounts on a shared device destroys their queued annotations.
 */
export function isOwnedBy(m: PendingMutation, userId?: string): boolean {
  if (m.userId == null) return true   // legacy or pre-auth — adoptable
  if (userId == null) return false    // signed out: don't claim anyone's rows
  return m.userId === userId
}
