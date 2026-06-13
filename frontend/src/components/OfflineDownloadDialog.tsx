import { useEffect, useMemo, useRef, useState } from 'react'
import type { Dataset, Project } from '../lib/types'
import {
  AVG_ION_KB,
  AVG_TIC_KB,
  downloadDatasetForOffline,
  removeDatasetOffline,
  type DownloadProgress,
} from '../lib/offline/download'
import { getOfflineDataset, type OfflineDatasetMeta } from '../lib/offline/db'

interface Props {
  project: Project
  dataset: Dataset
  onClose: () => void
}

function formatMB(kb: number): string {
  const mb = kb / 1024
  return mb < 1 ? `${Math.max(1, Math.round(kb))} KB` : `${mb.toFixed(mb < 10 ? 1 : 0)} MB`
}

export default function OfflineDownloadDialog({ project, dataset, onClose }: Props) {
  const total = dataset.total_ions
  const presets = useMemo(
    () => [...new Set([Math.min(1000, total), Math.min(3000, total), total])].sort((a, b) => a - b),
    [total],
  )

  const [existing, setExisting] = useState<OfflineDatasetMeta | null>(null)
  const [includeTic, setIncludeTic] = useState(false)
  const [count, setCount] = useState(presets[presets.length > 1 ? 1 : 0])
  const [status, setStatus] = useState<'idle' | 'downloading' | 'done' | 'error'>('idle')
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    getOfflineDataset(dataset.id).then((m) => {
      if (m) {
        setExisting(m)
        setIncludeTic(m.includeTic)
      }
    })
  }, [dataset.id])

  // Abort any in-flight download if the dialog unmounts (prevents setState-after-unmount
  // and wasted bandwidth).
  useEffect(() => () => abortRef.current?.abort(), [])

  const estKb = count * (AVG_ION_KB + (includeTic ? AVG_TIC_KB : 0))

  const start = async () => {
    setStatus('downloading')
    setError(null)
    abortRef.current = new AbortController()
    try {
      const res = await downloadDatasetForOffline({
        project,
        dataset,
        includeTic,
        count,
        onProgress: setProgress,
        signal: abortRef.current.signal,
      })
      setStatus('done')
      setExisting(await getOfflineDataset(dataset.id) ?? null)
      if (res.failed > 0) setError(`${res.failed} image${res.failed === 1 ? '' : 's'} could not be cached`)
    } catch (e) {
      if ((e as Error).name === 'AbortError') setStatus('idle')
      else {
        setStatus('error')
        setError('Download failed — check your connection and try again.')
      }
    }
  }

  const cancel = () => abortRef.current?.abort()

  const remove = async () => {
    await removeDatasetOffline(dataset.id)
    setExisting(null)
    setStatus('idle')
    setProgress(null)
  }

  const pct = progress && progress.total > 0 ? Math.round((progress.loaded / progress.total) * 100) : 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded-2xl bg-gray-900 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <h2 className="text-lg font-semibold text-white">Download for offline</h2>
          <button onClick={onClose} aria-label="Close" className="text-gray-500 hover:text-gray-300">
            ✕
          </button>
        </div>
        <p className="mt-1 text-sm text-gray-400">{dataset.name}</p>

        {existing && status !== 'done' && (
          <div className="mt-3 rounded-lg bg-gray-800/60 px-3 py-2 text-xs text-gray-300">
            Already available offline · {existing.ionCount.toLocaleString()} ions
            {existing.includeTic ? ' (with TIC)' : ''}. Re-download to update or change options.
          </div>
        )}

        {status === 'downloading' ? (
          <div className="mt-5 space-y-3">
            <div className="h-2 overflow-hidden rounded-full bg-gray-800">
              <div className="h-2 rounded-full bg-brand-orange transition-all" style={{ width: `${pct}%` }} />
            </div>
            <p className="text-center text-sm text-gray-400">
              {progress?.phase === 'queue' ? 'Preparing ions…' : `Caching images… ${pct}%`}
            </p>
            <button
              onClick={cancel}
              className="w-full rounded-lg bg-gray-800 px-4 py-2 text-sm font-medium text-gray-300 hover:bg-gray-700"
            >
              Cancel
            </button>
          </div>
        ) : status === 'done' ? (
          <div className="mt-5 space-y-3 text-center">
            <div className="text-3xl">✅</div>
            <p className="text-sm text-white">
              Offline ready · {existing?.ionCount.toLocaleString() ?? count.toLocaleString()} ions
            </p>
            {error && <p className="text-xs text-amber-400">{error}</p>}
            <button
              onClick={onClose}
              className="w-full rounded-lg bg-brand-orange px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-red"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            <div className="mt-4 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">How many ions</p>
              {presets.map((p) => (
                <label
                  key={p}
                  className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm transition-colors ${
                    count === p ? 'border-brand-orange bg-brand-orange/10 text-white' : 'border-gray-800 text-gray-300 hover:border-gray-600'
                  }`}
                >
                  <input
                    type="radio"
                    name="count"
                    checked={count === p}
                    onChange={() => setCount(p)}
                    className="accent-brand-orange"
                  />
                  {p === total ? `Whole dataset (${total.toLocaleString()})` : `Next ${p.toLocaleString()}`}
                </label>
              ))}
            </div>

            <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-gray-300">
              <input
                type="checkbox"
                checked={includeTic}
                onChange={(e) => setIncludeTic(e.target.checked)}
                className="accent-brand-orange"
              />
              Include TIC spectra (larger)
            </label>

            <p className="mt-3 text-center text-sm text-gray-400">
              Estimated size: <span className="font-semibold text-white">≈ {formatMB(estKb)}</span>
            </p>
            {error && status === 'error' && <p className="mt-2 text-center text-xs text-amber-400">{error}</p>}

            <button
              onClick={start}
              className="mt-4 w-full rounded-xl bg-brand-orange px-4 py-3 text-sm font-medium text-white hover:bg-brand-red"
            >
              Download
            </button>
            {existing && (
              <button onClick={remove} className="mt-2 w-full py-2 text-xs text-gray-500 hover:text-amber-400">
                Remove offline copy
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
