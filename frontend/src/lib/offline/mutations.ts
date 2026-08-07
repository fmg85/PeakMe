/**
 * Offline-aware mutation wrappers.
 *
 * Online (`navigator.onLine === true`): behave EXACTLY like the original direct API calls —
 * the network request runs and any error propagates to the caller (so the annotation card
 * resets on failure, unchanged behavior). We do NOT silently queue on an online failure.
 * Queuing is confined to genuine offline (`navigator.onLine === false`), where the action
 * is recorded in `pendingMutations` and the local snapshot is updated optimistically.
 *
 * Invariants:
 *  - IndexedDB problems never break the online path (best-effort via `safe()`).
 *  - A direct online write supersedes any still-queued offline mutation for the same ion.
 *  - Undo always drives the server to "no annotation" (so re-annotate-then-undo, where an
 *    older synced annotation may exist, removes it rather than leaving it behind).
 */
import apiClient from '../apiClient'
import { supabase } from '../supabaseClient'
import {
  addPending,
  getOfflineDataset,
  removePendingByIon,
  updateOfflineIon,
  type PendingMutation,
} from './db'
import { refreshPendingCount } from './sync'

/**
 * Queue an offline mutation, stamped with whoever is signed in right now.
 *
 * Every queue site goes through here so the stamp can't be forgotten. Without it, a
 * shared device replays one person's queued annotations under whoever signs in next,
 * permanently misattributing them — the queue is flushed on SIGNED_IN, so it does not
 * even need the same session to still be open.
 *
 * A missing id (not signed in, or the session lookup failed) is stored as `undefined`,
 * which `isOwnedBy` treats as adoptable — preserving today's behaviour rather than
 * stranding the mutation.
 */
async function queuePending(m: Omit<PendingMutation, 'id' | 'userId'>) {
  let userId: string | undefined
  try {
    userId = (await supabase.auth.getSession()).data.session?.user?.id
  } catch {
    userId = undefined
  }
  return addPending({ ...m, userId })
}

/** Run a best-effort IndexedDB op; never throw (so it can't break the online network path). */
async function safe<T>(op: () => Promise<T>): Promise<T | undefined> {
  try {
    return await op()
  } catch {
    return undefined
  }
}

function httpStatus(err: unknown): number | undefined {
  return (err as { response?: { status?: number } })?.response?.status
}

async function isDownloaded(datasetId: string): Promise<boolean> {
  return !!(await safe(() => getOfflineDataset(datasetId)))
}

export async function annotateIon(
  datasetId: string,
  ionId: string,
  labelOptionId: string,
  labelName: string,
) {
  const downloaded = await isDownloaded(datasetId)
  const applyLocal = () =>
    downloaded
      ? safe(() =>
          updateOfflineIon(datasetId, ionId, (it) => ({
            ...it,
            annotation: { label_option_id: labelOptionId, label_name: labelName, confidence: null },
          })),
        )
      : undefined

  if (navigator.onLine) {
    // Identical to the original direct call: errors propagate to the caller.
    await apiClient.post(`/api/ions/${ionId}/annotate`, { label_option_id: labelOptionId })
    await safe(() => removePendingByIon(datasetId, ionId, ['annotate', 'unannotate']))
    await applyLocal()
    void refreshPendingCount()
    return
  }

  // Offline: queue and update the local snapshot optimistically.
  await removePendingByIon(datasetId, ionId, ['annotate', 'unannotate'])
  await queuePending({ datasetId, ionId, type: 'annotate', labelOptionId, labelName, clientTs: Date.now() })
  await applyLocal()
  void refreshPendingCount()
}

export async function unannotateIon(datasetId: string, ionId: string) {
  const downloaded = await isDownloaded(datasetId)
  const clearLocal = () =>
    downloaded ? safe(() => updateOfflineIon(datasetId, ionId, (it) => ({ ...it, annotation: null }))) : undefined

  // Cancel any still-queued offline annotate/unannotate for this ion first.
  await safe(() => removePendingByIon(datasetId, ionId, ['annotate', 'unannotate']))

  if (navigator.onLine) {
    try {
      await apiClient.delete(`/api/ions/${ionId}/annotate`)
    } catch (err) {
      // 404 = nothing on the server to remove (e.g. the edit only existed locally). Any
      // other error propagates, matching the original undo behavior.
      if (httpStatus(err) !== 404) throw err
    }
    await clearLocal()
    void refreshPendingCount()
    return
  }

  // Offline: queue an unannotate so a prior *synced* annotation is removed on reconnect.
  // (If there was nothing on the server, the replay 404s and is dropped — harmless.)
  await queuePending({ datasetId, ionId, type: 'unannotate', clientTs: Date.now() })
  await clearLocal()
  void refreshPendingCount()
}

/** Returns the new starred state. */
export async function toggleStarIon(
  datasetId: string,
  ionId: string,
  currentStarred: boolean,
): Promise<boolean> {
  const downloaded = await isDownloaded(datasetId)
  const desired = !currentStarred
  const applyLocal = (starred: boolean) =>
    downloaded ? safe(() => updateOfflineIon(datasetId, ionId, (it) => ({ ...it, is_starred: starred }))) : undefined

  if (navigator.onLine) {
    const { data } = await apiClient.post<{ starred: boolean }>(`/api/ions/${ionId}/star`)
    await safe(() => removePendingByIon(datasetId, ionId, ['star']))
    await applyLocal(data.starred)
    void refreshPendingCount()
    return data.starred
  }

  await removePendingByIon(datasetId, ionId, ['star'])
  await queuePending({ datasetId, ionId, type: 'star', desiredStar: desired, clientTs: Date.now() })
  await applyLocal(desired)
  void refreshPendingCount()
  return desired
}
