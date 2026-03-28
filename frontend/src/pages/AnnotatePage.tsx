import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useDrag } from '@use-gesture/react'
import apiClient from '../lib/apiClient'
import { useAnnotationQueue } from '../hooks/useAnnotationQueue'
import type { Dataset, LabelOption, Project } from '../lib/types'

type AnimDirection = 'left' | 'right' | 'up' | 'down' | null
type SwipeDir = 'left' | 'right' | 'up' | 'down'

const SWIPE_COMMIT = 90   // px — distance to commit an annotation
const SWIPE_HINT  = 35   // px — distance to start showing the edge label

/** Determine dominant swipe direction from a drag delta */
function getDragDir(x: number, y: number): SwipeDir | null {
  const ax = Math.abs(x), ay = Math.abs(y)
  if (Math.max(ax, ay) < SWIPE_HINT) return null
  return ax > ay ? (x > 0 ? 'right' : 'left') : (y > 0 ? 'down' : 'up')
}

export default function AnnotatePage() {
  const { projectId } = useParams<{ projectId: string }>()
  const [searchParams] = useSearchParams()
  const datasetId = searchParams.get('dataset') ?? ''

  const [anim, setAnim] = useState<AnimDirection>(null)
  const [zoomed, setZoomed] = useState(false)
  const [strategy, setStrategy] = useState<'unannotated_first' | 'starred_first' | 'all'>('unannotated_first')
  const [sessionStarted, setSessionStarted] = useState(false)
  const [sessionAnnotations, setSessionAnnotations] = useState(0)
  const lastAnnotationRef = useRef<{ ionId: string; labelId: string } | null>(null)

  // Drag state for swipe gesture
  const [dragXY, setDragXY] = useState<[number, number]>([0, 0])
  const isDragging = dragXY[0] !== 0 || dragXY[1] !== 0

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

  // Auto-start immediately if this is the user's first visit (nothing annotated yet)
  useEffect(() => {
    if (dataset && !sessionStarted && dataset.my_annotation_count === 0) {
      setSessionStarted(true)
    }
  }, [dataset, sessionStarted])

  // Build swipe direction → label map
  const swipeMap = (project?.label_options ?? []).reduce<Partial<Record<SwipeDir, LabelOption>>>(
    (acc, l) => { if (l.swipe_direction) acc[l.swipe_direction] = l; return acc },
    {}
  )

  const annotate = useCallback(async (label: LabelOption, direction: AnimDirection = 'right') => {
    if (!current) return
    lastAnnotationRef.current = { ionId: current.id, labelId: label.id }
    setAnim(direction)
    try {
      await apiClient.post(`/api/ions/${current.id}/annotate`, { label_option_id: label.id })
      setSessionAnnotations((n) => n + 1)
    } catch {
      setAnim(null)
      return
    }
    setTimeout(() => { advance(); setAnim(null) }, 250)
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

  // Swipe gesture
  const bind = useDrag(({ down, movement: [mx, my], velocity: [vx, vy], cancel }) => {
    if (!current) return
    if (zoomed) { if (down) cancel(); return }

    if (down) {
      setDragXY([mx, my])
    } else {
      setDragXY([0, 0])
      const dir = getDragDir(mx, my)
      const dist = Math.sqrt(mx * mx + my * my)
      const speed = Math.sqrt(vx * vx + vy * vy)
      const label = dir ? swipeMap[dir] : null
      if (label && (dist >= SWIPE_COMMIT || speed > 0.6)) {
        annotate(label, dir)
      }
    }
  }, { filterTaps: true, pointer: { touch: true } })

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

  const annotated = (dataset?.my_annotation_count ?? 0) + sessionAnnotations
  const total = dataset?.total_ions ?? 0
  const remaining_unannotated = Math.max(0, total - annotated)
  const progress = total > 0 ? Math.round((annotated / total) * 100) : 0

  // Derived drag values
  const [dx, dy] = dragXY
  const dragDir = getDragDir(dx, dy)
  const dragDist = Math.sqrt(dx * dx + dy * dy)
  const committed = dragDist >= SWIPE_COMMIT

  const cardStyle: CSSProperties = {
    transform: isDragging
      ? `translate(${dx}px, ${dy}px) rotate(${dx * 0.06}deg)`
      : anim === 'left'  ? 'translateX(-120%) rotate(-20deg)'
      : anim === 'right' ? 'translateX(120%) rotate(20deg)'
      : anim === 'up'    ? 'translateY(-120%) rotate(-10deg)'
      : anim === 'down'  ? 'translateY(120%) rotate(10deg)'
      : 'translate(0,0) rotate(0deg)',
    transition: isDragging ? 'none' : 'transform 0.3s cubic-bezier(.25,.8,.25,1)',
    touchAction: 'none',
    userSelect: 'none',
    cursor: isDragging ? 'grabbing' : 'grab',
    willChange: 'transform',
  }

  if (!datasetId) {
    return (
      <div className="flex h-screen items-center justify-center text-gray-400">
        No dataset selected. <Link to={`/projects/${projectId}`} className="ml-2 text-indigo-400 underline">Go back</Link>
      </div>
    )
  }

  // Session start screen — shown when returning to a partially-annotated dataset
  if (!sessionStarted && dataset) {
    const pct = total > 0 ? Math.round(((dataset.my_annotation_count) / total) * 100) : 0
    const left = Math.max(0, total - dataset.my_annotation_count)
    return (
      <div className="flex h-screen flex-col bg-gray-950">
        <header className="flex items-center border-b border-gray-800 bg-gray-900 px-4 py-3">
          <Link to={`/projects/${projectId}`} className="text-sm text-gray-400 hover:text-white">
            ← {project?.name ?? 'Project'}
          </Link>
        </header>
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="w-full max-w-sm space-y-6">
            <div>
              <h1 className="text-xl font-bold text-white">{dataset.name}</h1>
              <p className="mt-1 text-sm text-gray-400">
                {dataset.my_annotation_count.toLocaleString()} of {total.toLocaleString()} ions annotated ({pct}%)
              </p>
              <div className="mt-3 h-2 rounded-full bg-gray-800">
                <div className="h-2 rounded-full bg-brand-orange transition-all" style={{ width: `${pct}%` }} />
              </div>
            </div>

            <div className="space-y-3">
              <button
                onClick={() => { setStrategy('unannotated_first'); setSessionStarted(true) }}
                className="w-full rounded-xl bg-brand-orange px-4 py-3 text-left font-medium text-white hover:bg-brand-red transition-colors"
              >
                <div>▶ Resume</div>
                <div className="text-sm font-normal opacity-80 mt-0.5">
                  Continue from where you left off · {left.toLocaleString()} ion{left !== 1 ? 's' : ''} remaining
                </div>
              </button>
              <button
                onClick={() => { setStrategy('all'); setSessionStarted(true) }}
                className="w-full rounded-xl bg-gray-800 px-4 py-3 text-left font-medium text-white hover:bg-gray-700 transition-colors"
              >
                <div>↩ Start from the beginning</div>
                <div className="text-sm font-normal text-gray-400 mt-0.5">
                  Review all {total.toLocaleString()} ions — re-annotate or change answers
                </div>
              </button>
              {dataset.my_annotation_count > 0 && (
                <button
                  onClick={() => { setStrategy('starred_first'); setSessionStarted(true) }}
                  className="w-full rounded-xl bg-gray-800 px-4 py-3 text-left font-medium text-yellow-400 hover:bg-gray-700 transition-colors"
                >
                  <div>★ Review starred only</div>
                  <div className="text-sm font-normal text-gray-400 mt-0.5">Go through ions you flagged for review</div>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col bg-gray-950 select-none overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-gray-800 bg-gray-900 px-4 py-3 flex-shrink-0">
        <Link to={`/projects/${projectId}`} className="text-sm text-gray-400 hover:text-white">
          ← {project?.name ?? 'Project'}
        </Link>
        <div className="text-center">
          <p className="text-sm font-medium text-white">{dataset?.name}</p>
          {dataset && (
            <p className="text-xs text-gray-500">
              {annotated.toLocaleString()} / {total.toLocaleString()} annotated
              {strategy === 'unannotated_first' && remaining_unannotated > 0 && ` · ${remaining_unannotated.toLocaleString()} left`}
            </p>
          )}
        </div>
        <Link to={`/projects/${projectId}/stats`} className="text-sm text-gray-400 hover:text-white">
          Stats
        </Link>
      </header>

      {/* Progress bar */}
      <div className="h-1 bg-gray-800 flex-shrink-0">
        <div className="h-1 bg-brand-orange transition-all duration-500" style={{ width: `${progress}%` }} />
      </div>

      {/* Main content */}
      <div className="flex flex-1 flex-col items-center justify-center px-4 py-4 overflow-hidden">
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
                onClick={() => { setSessionStarted(false); setSessionAnnotations(0) }}
                className="w-48 rounded-lg bg-brand-orange px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-red transition-colors"
              >
                Back to session menu
              </button>
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
            {/* m/z label */}
            <p className="mb-3 text-sm text-gray-400 font-mono flex-shrink-0">
              m/z = <span className="text-white font-semibold">{current.mz_value.toFixed(4)}</span>
              {current.annotation && (
                <span className="ml-3 text-indigo-400">← previously: {current.annotation.label_name}</span>
              )}
            </p>

            {/* Swipe arena — card + edge labels */}
            <div className="relative flex items-center justify-center" style={{ width: 'min(55vmin, 90vw)', height: 'min(55vmin, 90vw)' }}>

              {/* Edge labels — shown while dragging */}
              <SwipeEdge dir="left"  label={swipeMap.left}  active={dragDir === 'left'}  committed={committed && dragDir === 'left'}  opacity={(dragDir === 'left'  && isDragging) ? Math.min(1, (dragDist - SWIPE_HINT) / (SWIPE_COMMIT - SWIPE_HINT)) : 0} />
              <SwipeEdge dir="right" label={swipeMap.right} active={dragDir === 'right'} committed={committed && dragDir === 'right'} opacity={(dragDir === 'right' && isDragging) ? Math.min(1, (dragDist - SWIPE_HINT) / (SWIPE_COMMIT - SWIPE_HINT)) : 0} />
              <SwipeEdge dir="up"    label={swipeMap.up}    active={dragDir === 'up'}    committed={committed && dragDir === 'up'}    opacity={(dragDir === 'up'    && isDragging) ? Math.min(1, (dragDist - SWIPE_HINT) / (SWIPE_COMMIT - SWIPE_HINT)) : 0} />
              <SwipeEdge dir="down"  label={swipeMap.down}  active={dragDir === 'down'}  committed={committed && dragDir === 'down'}  opacity={(dragDir === 'down'  && isDragging) ? Math.min(1, (dragDist - SWIPE_HINT) / (SWIPE_COMMIT - SWIPE_HINT)) : 0} />

              {/* Ion image card */}
              <div
                {...bind()}
                className="absolute inset-0 rounded-xl overflow-hidden shadow-2xl"
                style={cardStyle}
                onClick={() => { if (!isDragging) setZoomed((z) => !z) }}
              >
                <img
                  src={current.image_url}
                  alt={`Ion m/z ${current.mz_value}`}
                  className={`w-full h-full block transition-transform duration-200 ${zoomed ? 'scale-150' : 'scale-100'}`}
                  style={{ imageRendering: 'pixelated' }}
                  draggable={false}
                />
                {current.is_starred && (
                  <div className="absolute top-2 right-2 text-yellow-400 text-lg drop-shadow">★</div>
                )}
              </div>
            </div>

            {/* Label buttons */}
            <div className="mt-5 flex flex-wrap justify-center gap-2 max-w-lg flex-shrink-0">
              {project?.label_options.map((label, i) => (
                <button
                  key={label.id}
                  onClick={() => annotate(label, i < (project.label_options.length / 2) ? 'left' : 'right')}
                  className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold text-white shadow-lg hover:brightness-110 active:scale-95 transition-all"
                  style={{ backgroundColor: label.color || '#6366f1' }}
                >
                  {label.swipe_direction && (
                    <span className="text-xs opacity-70">{dirArrow(label.swipe_direction)}</span>
                  )}
                  {label.keyboard_shortcut && (
                    <kbd className="rounded bg-black/20 px-1 py-0.5 text-xs">{label.keyboard_shortcut}</kbd>
                  )}
                  {label.name}
                </button>
              ))}
            </div>

            {/* Star + Undo */}
            <div className="mt-3 flex items-center gap-4 flex-shrink-0">
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

            {/* Swipe hint — only if any swipe labels configured */}
            {Object.keys(swipeMap).length > 0 && !isDragging && (
              <p className="mt-2 text-xs text-gray-600 flex-shrink-0">
                Swipe to annotate · S to star · Z to undo
              </p>
            )}
            {Object.keys(swipeMap).length === 0 && (
              <p className="mt-2 text-xs text-gray-600 flex-shrink-0">
                Press label key to annotate · S to star · Z to undo
              </p>
            )}
          </>
        ) : (
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
        )}
      </div>
    </div>
  )
}

// ─── helpers ────────────────────────────────────────────────────────────────

function dirArrow(dir: string) {
  return { left: '←', right: '→', up: '↑', down: '↓' }[dir] ?? ''
}

interface SwipeEdgeProps {
  dir: SwipeDir
  label: LabelOption | undefined
  active: boolean
  committed: boolean
  opacity: number
}

function SwipeEdge({ dir, label, opacity }: SwipeEdgeProps) {
  if (!label || opacity <= 0) return null

  const posStyle = ({
    left:  { position: 'absolute' as const, left: 0, top: '50%', transform: 'translate(-50%, -50%)' },
    right: { position: 'absolute' as const, right: 0, top: '50%', transform: 'translate(50%, -50%)' },
    up:    { position: 'absolute' as const, top: 0, left: '50%', transform: 'translate(-50%, -50%)' },
    down:  { position: 'absolute' as const, bottom: 0, left: '50%', transform: 'translate(-50%, 50%)' },
  } satisfies Record<SwipeDir, CSSProperties>)[dir]

  return (
    <div
      className="flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-bold text-white shadow-2xl pointer-events-none z-10"
      style={{ ...posStyle, backgroundColor: label.color || '#6366f1', opacity }}
    >
      <span>{dirArrow(dir)}</span>
      <span>{label.name}</span>
    </div>
  )
}
