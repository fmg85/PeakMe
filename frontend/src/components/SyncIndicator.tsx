import { useSyncStatus } from '../lib/offline/sync'

/** Compact offline / sync status pill. Renders nothing when online and fully synced. */
export default function SyncIndicator() {
  const { online, syncing, pending, lastError } = useSyncStatus()

  if (online && !syncing && pending === 0 && !lastError) return null

  let text: string
  let tone = 'text-gray-400 bg-gray-800'
  if (!online) {
    text = pending > 0 ? `Offline · ${pending} to sync` : 'Offline'
    tone = 'text-amber-400 bg-amber-500/10'
  } else if (syncing) {
    text = `Syncing${pending > 0 ? ` · ${pending}` : '…'}`
    tone = 'text-indigo-300 bg-indigo-500/10'
  } else if (lastError) {
    text = lastError
    tone = 'text-amber-400 bg-amber-500/10'
  } else {
    text = `${pending} to sync`
  }

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
      {syncing && (
        <span className="h-2.5 w-2.5 animate-spin rounded-full border border-current border-t-transparent" />
      )}
      {!online && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {text}
    </span>
  )
}
