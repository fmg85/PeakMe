/**
 * Sync reconciler.
 *
 * Replays the offline `pendingMutations` queue against the EXISTING API endpoints
 * (annotate / unannotate / star). Idempotent for annotate/unannotate thanks to the
 * server's `(ion_id, user_id)` upsert; stars converge to a stored desired state.
 *
 * Also exposes a tiny external store (`useSyncStatus`) for the offline/sync UI.
 */
import { useSyncExternalStore } from 'react'
import apiClient from '../apiClient'
import { supabase } from '../supabaseClient'
import { countPending, deletePending, getAllPending, getPendingById } from './db'

export interface SyncState {
  online: boolean
  syncing: boolean
  pending: number
  lastError: string | null
}

let state: SyncState = {
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  syncing: false,
  pending: 0,
  lastError: null,
}
const listeners = new Set<() => void>()

function setState(patch: Partial<SyncState>) {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

export function subscribeSync(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getSyncState() {
  return state
}

export function useSyncStatus(): SyncState {
  return useSyncExternalStore(subscribeSync, getSyncState, getSyncState)
}

export async function refreshPendingCount() {
  try {
    setState({ pending: await countPending() })
  } catch {
    /* ignore */
  }
}

/** Treat connection failures (offline) as retryable; surface real HTTP errors. */
export function isNetworkError(err: unknown): boolean {
  const e = err as { code?: string; response?: unknown }
  if (!e) return false
  // An explicitly canceled/aborted request is NOT an offline signal.
  if (e.code === 'ERR_CANCELED') return false
  return e.code === 'ERR_NETWORK' || e.code === 'ECONNABORTED' || e.response == null
}

let flushing = false
let retryTimer: ReturnType<typeof setTimeout> | null = null
// Called after a flush that actually pushed ≥1 mutation to the server, so the app can
// refresh cached views (dataset counts, label summaries) without a manual reload.
let onSyncedCb: (() => void) | null = null

/** Schedule a single delayed flush after a transient server error (coalesced). */
function scheduleRetry() {
  if (retryTimer) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    void flushPendingMutations()
  }, 30_000)
}

export async function flushPendingMutations(): Promise<void> {
  if (flushing || !navigator.onLine) return
  // Serialize across tabs/PWA windows so two of them don't replay the shared queue at once.
  const locks = (navigator as Navigator & { locks?: LockManager }).locks
  if (locks?.request) {
    return locks.request('peakme-sync', { ifAvailable: true }, async (lock) => {
      if (lock) await doFlush()
    })
  }
  return doFlush()
}

async function doFlush(): Promise<void> {
  if (flushing || !navigator.onLine) return
  flushing = true
  setState({ syncing: true, lastError: null })
  let synced = 0
  try {
    const pending = await getAllPending()
    for (const m of pending) {
      try {
        // A direct online write may have superseded (deleted) this entry since we read
        // the snapshot — re-check so we never replay a stale label over a newer one.
        if (m.id != null && !(await getPendingById(m.id))) continue
        if (m.type === 'annotate') {
          await apiClient.post(`/api/ions/${m.ionId}/annotate`, { label_option_id: m.labelOptionId })
        } else if (m.type === 'unannotate') {
          try {
            await apiClient.delete(`/api/ions/${m.ionId}/annotate`)
          } catch (err) {
            // 404 = already absent on the server; treat as done.
            if (!isNetworkError(err) && (err as { response?: { status?: number } }).response?.status !== 404) throw err
          }
        } else if (m.type === 'star') {
          // The endpoint toggles, so converge toward the desired state (≤2 calls). Only
          // drop the mutation once the server actually reports the desired state — if the
          // corrective call didn't land it, leave it queued to retry.
          let { data } = await apiClient.post<{ starred: boolean }>(`/api/ions/${m.ionId}/star`)
          if (data.starred !== m.desiredStar) {
            ;({ data } = await apiClient.post<{ starred: boolean }>(`/api/ions/${m.ionId}/star`))
          }
          if (data.starred !== m.desiredStar) {
            setState({ lastError: 'Sync error — will retry' })
            continue
          }
        }
        if (m.id != null) { await deletePending(m.id); synced++ }
      } catch (err) {
        if (isNetworkError(err)) {
          // Back offline — stop, keep the rest queued for the next reconnect.
          setState({ syncing: false, online: false })
          await refreshPendingCount()
          return
        }
        const status = (err as { response?: { status?: number } }).response?.status
        if (status === 401) {
          // Token not (yet) valid — leave queued; a later auth refresh will retry.
          setState({ syncing: false, lastError: 'Sign in to finish syncing' })
          await refreshPendingCount()
          return
        }
        if (status === 404) {
          // Ion or label no longer exists — drop this mutation and continue.
          if (m.id != null) await deletePending(m.id)
          continue
        }
        // Unexpected server error (e.g. 5xx): stop this pass rather than hammering the
        // whole queue. Schedule one backoff retry so a foreground/online user recovers
        // without needing a reconnect/visibility event; the rest also retry on triggers.
        setState({ lastError: 'Sync error — will retry' })
        scheduleRetry()
        break
      }
    }
  } finally {
    await refreshPendingCount()
    setState({ syncing: false })
    flushing = false
    if (synced > 0) {
      try {
        onSyncedCb?.()
      } catch {
        /* cache invalidation is best-effort */
      }
    }
  }
}

let initialized = false

/** Wire up reconnect / foreground triggers. Call once at app start. */
export function initSync(opts?: { onSynced?: () => void }) {
  if (initialized || typeof window === 'undefined') return
  initialized = true
  onSyncedCb = opts?.onSynced ?? null

  window.addEventListener('online', () => {
    setState({ online: true })
    void flushPendingMutations()
  })
  window.addEventListener('offline', () => setState({ online: false }))
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && navigator.onLine) void flushPendingMutations()
  })

  // A 401 during sync leaves the queue parked until auth recovers — retry once the
  // token is refreshed or the user signs back in.
  supabase.auth.onAuthStateChange((event) => {
    if ((event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') && navigator.onLine) {
      void flushPendingMutations()
    }
  })

  void refreshPendingCount()
  if (navigator.onLine) void flushPendingMutations()
}
