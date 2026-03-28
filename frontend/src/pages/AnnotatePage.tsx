import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import apiClient from '../lib/apiClient'
import { useAnnotationQueue } from '../hooks/useAnnotationQueue'
import type { Dataset, LabelOption, Project } from '../lib/types'

type AnimDirection = 'left' | 'right' | null

export default function AnnotatePage() {
  const { projectId } = useParams<{ projectId: string }>()
  const [searchParams] = useSearchParams()
  const datasetId = searchParams.get('dataset') ?? ''

  const [anim, setAnim] = useState<AnimDirection>(null)
  const [zoomed, setZoomed] = useState(false)
  const [strategy, setStrategy] = useState<'unannotated_first' | 'starred_first' | 'all'>('unannotated_first')
  const lastAnnotationRef = useRef<{ ionId: string; labelId: string } | null>(null)

  const { data: project } = useQuery<Project>({
    queryKey: ['project', projectId],
    queryFn: () => apiClient.get(`/api/projects/${projectId}`).then((r) => r.data),
  })

  const { data: dataset } = useQuery<Dataset>({
    queryKey: ['dataset', datasetId],
    queryFn: () => apiClient.get(`/api/datasets/${datasetId}`).then((r) => r.data),
    enabled: !!datasetId,
  })

  const { current, remaining, advance, updateCurrent, exhausted, forceReload } = useAnnotationQueue({
    datasetId,
    strategy,
  })

  const annotate = useCallback(async (label: LabelOption, direction: AnimDirection = 'right') => {
    if (!current) return

    lastAnnotationRef.current = { ionId: current.id, labelId: label.id }

    // Optimistic: start animation immediately
    setAnim(direction)

    try {
      await apiClient.post(`/api/ions/${current.id}/annotate`, {
        label_option_id: label.id,
      })
    } catch {
      // On error, stay on current ion
      setAnim(null)
      return
    }

    // Advance after animation (250ms)
    setTimeout(() => {
      advance()
      setAnim(null)
    }, 250)
  }, [current, advance])

  const toggleStar = useCallback(async () => {
    if (!current) return
    const { data } = await apiClient.post(`/api/ions/${current.id}/star`)
    updateCurrent((item) => ({ ...item, is_starred: data.starred }))
  }, [current, updateCurrent])

  const undo = useCallback(async () => {
    const last = lastAnnotationRef.current
    if (!last) return
    lastAnnotationRef.current = null
    await apiClient.delete(`/api/ions/${last.ionId}/annotate`)
    forceReload()
  }, [forceReload])

  // Keyboard shortcuts
  useEffect(() => {
    const labels = project?.label_options ?? []
    const handleKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 's' || e.key === 'S') { toggleStar(); return }
      if (e.key === 'z' || e.key === 'Z') { undo(); return }
      const label = labels.find((l) => l.keyboard_shortcut === e.key)
      if (label) annotate(label)
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [project, annotate, toggleStar, undo])

  const annotated = (dataset?.total_ions ?? 0) - remaining
  const progress = dataset ? Math.round((annotated / dataset.total_ions) * 100) : 0

  if (!datasetId) {
    return (
      <div className="flex h-screen items-center justify-center text-gray-400">
        No dataset selected. <Link to={`/projects/${projectId}`} className="ml-2 text-indigo-400 underline">Go back</Link>
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col bg-gray-950 select-none">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-gray-800 bg-gray-900 px-4 py-3">
        <Link to={`/projects/${projectId}`} className="text-sm text-gray-400 hover:text-white">
          ← {project?.name ?? 'Project'}
        </Link>
        <div className="text-center">
          <p className="text-sm font-medium text-white">{dataset?.name}</p>
          {dataset && (
            <p className="text-xs text-gray-500">
              {annotated.toLocaleString()} / {dataset.total_ions.toLocaleString()} annotated by you
            </p>
          )}
        </div>
        <Link to={`/projects/${projectId}/stats`} className="text-sm text-gray-400 hover:text-white">
          Stats
        </Link>
      </header>

      {/* Progress bar */}
      <div className="h-1 bg-gray-800">
        <div
          className="h-1 bg-brand-orange transition-all duration-500"
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Main content */}
      <div className="flex flex-1 flex-col items-center justify-center px-4 py-6 overflow-hidden">
        {exhausted && !current ? (
          <div className="text-center space-y-4 max-w-sm">
            <div className="text-5xl">🎉</div>
            <h2 className="text-xl font-semibold text-white">
              {strategy === 'unannotated_first' ? 'All done!' : strategy === 'starred_first' ? 'No starred ions' : 'End of dataset'}
            </h2>
            <p className="text-gray-400">
              {strategy === 'unannotated_first'
                ? `You've annotated all ${dataset?.total_ions} ions in this dataset.`
                : strategy === 'starred_first'
                ? 'No starred ions found.'
                : 'You reached the end of the dataset.'}
            </p>
            <div className="flex flex-col gap-2 items-center">
              <button
                onClick={() => { if (strategy === 'all') forceReload(); else setStrategy('all') }}
                className="w-48 rounded-lg bg-gray-800 px-4 py-2.5 text-sm font-medium text-white hover:bg-gray-700 transition-colors"
              >
                Review all ions
              </button>
              <button
                onClick={() => setStrategy('starred_first')}
                className="w-48 rounded-lg bg-gray-800 px-4 py-2.5 text-sm font-medium text-yellow-400 hover:bg-gray-700 transition-colors"
              >
                ★ Review starred
              </button>
              <Link
                to={`/projects/${projectId}`}
                className="w-48 rounded-lg bg-brand-orange px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-red transition-colors text-center"
              >
                Back to project
              </Link>
            </div>
          </div>
        ) : current ? (
          <>
            {/* m/z value */}
            <p className="mb-3 text-sm text-gray-400 font-mono">
              m/z = <span className="text-white font-semibold">{current.mz_value.toFixed(4)}</span>
              {current.annotation && (
                <span className="ml-3 text-indigo-400">← previously: {current.annotation.label_name}</span>
              )}
            </p>

            {/* Ion image card */}
            <div
              className={`relative rounded-xl overflow-hidden shadow-2xl transition-all
                ${anim === 'left' ? 'animate-slide-left' : anim === 'right' ? 'animate-slide-right' : 'animate-fade-in'}
                ${zoomed ? 'cursor-zoom-out' : 'cursor-zoom-in'}
              `}
              style={{ width: 'min(55vmin, 90vw)', aspectRatio: '1 / 1' }}
              onClick={() => setZoomed((z) => !z)}
            >
              <img
                src={current.image_url}
                alt={`Ion m/z ${current.mz_value}`}
                className={`w-full block transition-transform duration-200 ${zoomed ? 'scale-150' : 'scale-100'}`}
                style={{ imageRendering: 'pixelated' }}
              />

              {/* Star badge */}
              {current.is_starred && (
                <div className="absolute top-2 right-2 text-yellow-400 text-lg drop-shadow">★</div>
              )}
            </div>

            {/* Label buttons */}
            <div className="mt-6 flex flex-wrap justify-center gap-2 max-w-lg">
              {project?.label_options.map((label, i) => (
                <button
                  key={label.id}
                  onClick={() => annotate(label, i < (project.label_options.length / 2) ? 'left' : 'right')}
                  className="flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white shadow-lg hover:brightness-110 active:scale-95 transition-all"
                  style={{ backgroundColor: label.color || '#6366f1' }}
                >
                  {label.keyboard_shortcut && (
                    <kbd className="rounded bg-black/20 px-1 py-0.5 text-xs">{label.keyboard_shortcut}</kbd>
                  )}
                  {label.name}
                </button>
              ))}
            </div>

            {/* Star + Undo */}
            <div className="mt-4 flex items-center gap-4">
              <button
                onClick={toggleStar}
                className={`flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition-colors
                  ${current.is_starred
                    ? 'bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30'
                    : 'bg-gray-800 text-gray-400 hover:text-yellow-400 hover:bg-gray-700'
                  }`}
                title="Star (S)"
              >
                {current.is_starred ? '★' : '☆'} Star
                <kbd className="rounded bg-black/20 px-1 py-0.5 text-xs">S</kbd>
              </button>
              <button
                onClick={undo}
                disabled={!lastAnnotationRef.current}
                className="flex items-center gap-1.5 rounded-lg bg-gray-800 px-4 py-2 text-sm font-medium text-gray-400 hover:text-white hover:bg-gray-700 disabled:opacity-30 transition-colors"
                title="Undo (Z)"
              >
                ↩ Undo
                <kbd className="rounded bg-black/20 px-1 py-0.5 text-xs">Z</kbd>
              </button>
            </div>

            {/* Keyboard hint */}
            <p className="mt-4 text-xs text-gray-600">
              Press label key to annotate · S to star · Z to undo
            </p>
          </>
        ) : (
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
        )}
      </div>
    </div>
  )
}
