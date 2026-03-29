import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useDrag } from '@use-gesture/react'
import apiClient from '../lib/apiClient'
import { useAnnotationQueue } from '../hooks/useAnnotationQueue'
import type { Dataset, DatasetLabelSummary, IonQueueItem, LabelOption, Project } from '../lib/types'

type AnimDirection = 'left' | 'right' | 'up' | 'down' | null
type SwipeDir = 'left' | 'right' | 'up' | 'down'
type Layer = 'ion' | 'tic' | 'fluorescence' | 'overlay'

const LAYER_NAMES: Record<Layer, string> = {
  ion: 'Ion image',
  tic: 'TIC spectrum',
  fluorescence: 'Fluorescence',
  overlay: 'Ion + outline',
}

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
  const queryClient = useQueryClient()

  const [anim, setAnim] = useState<AnimDirection>(null)
  const [layerIndex, setLayerIndex] = useState(0)
  const [strategy, setStrategy] = useState<'unannotated_first' | 'starred_first' | 'all'>('unannotated_first')
  const [labelFilter, setLabelFilter] = useState<string | null>(null)
  const [sessionStarted, setSessionStarted] = useState(false)
  const [sessionAnnotations, setSessionAnnotations] = useState(0)
  // Snapshot of my_annotation_count at the moment the user clicks Resume/Start.
  // We freeze it here so that React Query background refetches mid-session
  // can't corrupt the counter (if my_annotation_count updated to include session
  // annotations, "annotated = my_annotation_count + sessionAnnotations" would
  // double-count and "remaining" would show a wrong non-zero value at exhaustion).
  const [baselineAnnotations, setBaselineAnnotations] = useState(0)
  const [undoStack, setUndoStack] = useState<IonQueueItem[]>([])  // full items, most-recent last

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

  const { current, remaining, advance, updateCurrent, exhausted, forceReload, prependItem } = useAnnotationQueue({
    datasetId,
    strategy,
    labelFilter,
  })

  const { data: labelSummary } = useQuery<DatasetLabelSummary>({
    queryKey: ['dataset-label-summary', datasetId],
    queryFn: () => apiClient.get(`/api/datasets/${datasetId}/label-summary`).then((r) => r.data),
    enabled: !!datasetId && (dataset?.my_annotation_count ?? 0) > 0,
  })

  // No auto-start: always wait for dataset to load and show the session screen.
  // (Previous auto-start on my_annotation_count===0 was unreliable because
  // React Query could serve a stale cached 0 before fresh data arrived.)

  // Invalidate the project's dataset list when leaving, so ProjectDetailPage
  // always shows fresh annotation counts without a manual refresh
  useEffect(() => {
    return () => {
      queryClient.invalidateQueries({ queryKey: ['datasets', projectId] })
    }
  }, [queryClient, projectId])

  // Build swipe direction → label map
  const swipeMap = (project?.label_options ?? []).reduce<Partial<Record<SwipeDir, LabelOption>>>(
    (acc, l) => { if (l.swipe_direction) acc[l.swipe_direction] = l; return acc },
    {}
  )

  const annotate = useCallback(async (label: LabelOption, direction: AnimDirection = 'right') => {
    if (!current) return
    const snapshot = current  // capture before async
    const wasAlreadyAnnotated = !!snapshot.annotation  // don't inflate counter on re-annotation
    setAnim(direction)
    try {
      await apiClient.post(`/api/ions/${snapshot.id}/annotate`, { label_option_id: label.id })
      setUndoStack((s) => [...s, snapshot])
      if (!wasAlreadyAnnotated) setSessionAnnotations((n) => n + 1)
    } catch {
      setAnim(null)
      return
    }
    setTimeout(() => { advance(); setAnim(null) }, 320)
  }, [current, advance])

  const toggleStar = useCallback(async () => {
    if (!current) return
    const { data } = await apiClient.post(`/api/ions/${current.id}/star`)
    updateCurrent((item) => ({ ...item, is_starred: data.starred }))
  }, [current, updateCurrent])

  const undo = useCallback(async () => {
    if (undoStack.length === 0) return
    const item = undoStack[undoStack.length - 1]
    setUndoStack((s) => s.slice(0, -1))
    setSessionAnnotations((n) => Math.max(0, n - 1))
    await apiClient.delete(`/api/ions/${item.id}/annotate`)
    // Prepend the undone ion back to the front of the queue (no reload needed).
    // This always lands on exactly the ion that was undone, regardless of strategy.
    prependItem({ ...item, annotation: null })
  }, [undoStack, prependItem])

  // Swipe gesture
  const bind = useDrag(({ down, movement: [mx, my], velocity: [vx, vy] }) => {
    if (!current) return

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

  const total = dataset?.total_ions ?? 0
  // For resume mode: show overall annotation progress using the frozen baseline
  // (captured at session start) plus new annotations made this session.
  // For "all" / "starred" modes: show position within this review session only.
  const annotated = strategy === 'unannotated_first'
    ? baselineAnnotations + sessionAnnotations
    : sessionAnnotations
  const remaining_unannotated = Math.max(0, total - baselineAnnotations - (strategy === 'unannotated_first' ? sessionAnnotations : 0))

  // Layer cycling: ion image → TIC spectrum → fluorescence → outline overlay → repeat
  const availableLayers = useMemo((): Layer[] => {
    const layers: Layer[] = ['ion']
    if (current?.tic_image_url) layers.push('tic')
    if (dataset?.fluorescence_url) layers.push('fluorescence')
    if (dataset?.fluorescence_outline_url) layers.push('overlay')
    return layers
  }, [current?.tic_image_url, dataset?.fluorescence_url, dataset?.fluorescence_outline_url])

  const currentLayer = availableLayers[layerIndex % availableLayers.length] ?? 'ion'

  const cycleLayer = useCallback(() => {
    if (availableLayers.length <= 1) return
    setLayerIndex((prev) => (prev + 1) % availableLayers.length)
  }, [availableLayers.length])

  // Reset to the ion layer whenever the card changes
  useEffect(() => { setLayerIndex(0) }, [current?.id])

  // When the queue exhausts, refresh the dataset so the header and session-start
  // screen show the true my_annotation_count for next time.
  useEffect(() => {
    if (exhausted && sessionStarted) {
      queryClient.invalidateQueries({ queryKey: ['dataset', datasetId] })
    }
  }, [exhausted, sessionStarted, queryClient, datasetId])
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

  // Session start screen — shown until the user picks a mode
  // Always shown (even first visit) so we never rely on async data for auto-start
  if (!sessionStarted && dataset) {
    const isFirstVisit = dataset.my_annotation_count === 0
    const isFullyDone = !isFirstVisit && dataset.my_annotation_count >= total && total > 0
    const pct = total > 0 ? Math.round((dataset.my_annotation_count / total) * 100) : 0
    const left = Math.max(0, total - dataset.my_annotation_count)

    const startSession = (strat: typeof strategy, filter: string | null = null) => {
      setLabelFilter(filter)
      setStrategy(strat)
      setBaselineAnnotations(dataset.my_annotation_count)
      setSessionStarted(true)
    }

    return (
      <div className="flex h-screen flex-col bg-gray-950">
        <header className="flex items-center border-b border-gray-800 bg-gray-900 px-4 py-3">
          <Link to={`/projects/${projectId}`} className="text-sm text-gray-400 hover:text-white">
            ← {project?.name ?? 'Project'}
          </Link>
        </header>
        <div className="flex flex-1 items-center justify-center p-6 overflow-y-auto">
          <div className="w-full max-w-sm space-y-6 py-4">
            <div>
              <h1 className="text-xl font-bold text-white">{dataset.name}</h1>
              <p className="mt-1 text-sm text-gray-400">
                {isFirstVisit
                  ? `${total.toLocaleString()} ions ready to annotate`
                  : `${dataset.my_annotation_count.toLocaleString()} of ${total.toLocaleString()} ions annotated (${pct}%)`}
              </p>
              {!isFirstVisit && (
                <div className="mt-3 h-2 rounded-full bg-gray-800">
                  <div className="h-2 rounded-full bg-brand-orange transition-all" style={{ width: `${pct}%` }} />
                </div>
              )}
            </div>

            <div className="space-y-3">
              {/* Primary action — only show Resume when there are unannotated ions left */}
              {!isFullyDone && (
                <button
                  onClick={() => startSession('unannotated_first')}
                  className="w-full rounded-xl bg-brand-orange px-4 py-3 text-left font-medium text-white hover:bg-brand-red transition-colors"
                >
                  <div>{isFirstVisit ? '▶ Start annotating' : '▶ Resume'}</div>
                  <div className="text-sm font-normal opacity-80 mt-0.5">
                    {isFirstVisit
                      ? `Annotate ${total.toLocaleString()} ions in order`
                      : `Continue from where you left off · ${left.toLocaleString()} ion${left !== 1 ? 's' : ''} remaining`}
                  </div>
                </button>
              )}

              {!isFirstVisit && (
                <>
                  <button
                    onClick={() => startSession('all')}
                    className={`w-full rounded-xl px-4 py-3 text-left font-medium text-white transition-colors ${isFullyDone ? 'bg-brand-orange hover:bg-brand-red' : 'bg-gray-800 hover:bg-gray-700'}`}
                  >
                    <div>↩ Start from the beginning</div>
                    <div className="text-sm font-normal text-gray-400 mt-0.5">
                      Review all {total.toLocaleString()} ions — re-annotate or change answers
                    </div>
                  </button>
                  <button
                    onClick={() => startSession('starred_first')}
                    className="w-full rounded-xl bg-gray-800 px-4 py-3 text-left font-medium text-yellow-400 hover:bg-gray-700 transition-colors"
                  >
                    <div>★ Review starred only</div>
                    <div className="text-sm font-normal text-gray-400 mt-0.5">Go through ions you flagged for review</div>
                  </button>
                </>
              )}
            </div>

            {/* Review by label — shown once there are annotated ions with label breakdown */}
            {labelSummary && labelSummary.labels.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">Review by label</p>
                <div className="space-y-2">
                  {labelSummary.labels.map((lb) => {
                    const labelOption = project?.label_options.find((l) => l.name === lb.label_name)
                    const color = labelOption?.color ?? '#6366f1'
                    return (
                      <button
                        key={lb.label_name}
                        onClick={() => startSession('all', lb.label_name)}
                        className="w-full rounded-xl bg-gray-900 border border-gray-800 px-4 py-3 text-left hover:border-gray-600 transition-colors"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
                            <span className="font-medium text-white">{lb.label_name}</span>
                          </div>
                          <span className="text-sm text-gray-400">{lb.count.toLocaleString()} ions · {lb.pct}%</span>
                        </div>
                        <div className="text-xs text-gray-500 mt-0.5 pl-5">Review and re-annotate this category</div>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
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
              {labelFilter
                ? (() => {
                    const color = project?.label_options.find((l) => l.name === labelFilter)?.color
                    return <span className="flex items-center justify-center gap-1">
                      {color && <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: color }} />}
                      Reviewing: {labelFilter} · {sessionAnnotations.toLocaleString()} done
                    </span>
                  })()
                : strategy === 'unannotated_first'
                ? `${annotated.toLocaleString()} / ${total.toLocaleString()} annotated${remaining_unannotated > 0 ? ` · ${remaining_unannotated.toLocaleString()} left` : ''}`
                : strategy === 'all'
                ? `Reviewing all · ${sessionAnnotations.toLocaleString()} / ${total.toLocaleString()}`
                : `Starred · ${sessionAnnotations.toLocaleString()} reviewed`}
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
      <div className="flex flex-1 flex-col items-center justify-center px-4 py-2 overflow-hidden">
        {exhausted && !current ? (
          <div className="text-center space-y-4 max-w-sm w-full">
            <div className="text-5xl">🎉</div>
            <h2 className="text-xl font-semibold text-white">
              {strategy === 'unannotated_first' ? 'All done!' : strategy === 'starred_first' ? 'No starred ions' : 'End of dataset'}
            </h2>
            <p className="text-gray-400">
              {strategy === 'unannotated_first'
                ? `You've annotated all ${total.toLocaleString()} ions in this dataset.`
                : strategy === 'starred_first'
                ? 'No starred ions found.'
                : 'You reached the end of the dataset.'}
            </p>

            {/* Label breakdown */}
            {labelSummary && labelSummary.labels.length > 0 && (
              <div className="rounded-xl bg-gray-900 p-4 text-left space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">Your annotations</p>
                <div className="space-y-1.5">
                  {labelSummary.labels.map((lb) => {
                    const labelOption = project?.label_options.find((l) => l.name === lb.label_name)
                    const color = labelOption?.color ?? '#6366f1'
                    const barPct = labelSummary.total > 0 ? (lb.count / labelSummary.total) * 100 : 0
                    return (
                      <div key={lb.label_name}>
                        <div className="flex justify-between text-xs mb-0.5">
                          <span className="text-gray-300 flex items-center gap-1.5">
                            <span className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
                            {lb.label_name}
                          </span>
                          <span className="text-gray-500">{lb.count.toLocaleString()} · {lb.pct}%</span>
                        </div>
                        <div className="h-1 rounded-full bg-gray-800">
                          <div className="h-1 rounded-full transition-all" style={{ width: `${barPct}%`, backgroundColor: color }} />
                        </div>
                      </div>
                    )
                  })}
                  {labelSummary.unannotated > 0 && (
                    <div className="pt-1 flex justify-between text-xs text-gray-600 border-t border-gray-800">
                      <span>Unannotated</span>
                      <span>{labelSummary.unannotated.toLocaleString()} · {Math.round(labelSummary.unannotated / labelSummary.total * 100)}%</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="flex flex-col gap-2 items-center">
              <button
                onClick={() => {
                  setSessionStarted(false)
                  setSessionAnnotations(0)
                  setBaselineAnnotations(0)
                  setLabelFilter(null)
                  setUndoStack([])
                  queryClient.invalidateQueries({ queryKey: ['dataset', datasetId] })
                  queryClient.invalidateQueries({ queryKey: ['dataset-label-summary', datasetId] })
                }}
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
            <p className="mb-1 text-sm text-gray-400 font-mono flex-shrink-0">
              m/z = <span className="text-white font-semibold">{current.mz_value.toFixed(4)}</span>
              {current.annotation && (
                <span className="ml-3 text-indigo-400">← previously: {current.annotation.label_name}</span>
              )}
            </p>

            {/* Swipe arena — card + edge labels */}
            <div className="relative flex items-center justify-center" style={{ width: 'min(calc(100vh - 230px), calc(100vw - 32px))', height: 'min(calc(100vh - 230px), calc(100vw - 32px))' }}>

              {/* Edge labels — shown while dragging */}
              <SwipeEdge dir="left"  label={swipeMap.left}  active={dragDir === 'left'}  committed={committed && dragDir === 'left'}  opacity={(dragDir === 'left'  && isDragging) ? Math.min(1, (dragDist - SWIPE_HINT) / (SWIPE_COMMIT - SWIPE_HINT)) : 0} />
              <SwipeEdge dir="right" label={swipeMap.right} active={dragDir === 'right'} committed={committed && dragDir === 'right'} opacity={(dragDir === 'right' && isDragging) ? Math.min(1, (dragDist - SWIPE_HINT) / (SWIPE_COMMIT - SWIPE_HINT)) : 0} />
              <SwipeEdge dir="up"    label={swipeMap.up}    active={dragDir === 'up'}    committed={committed && dragDir === 'up'}    opacity={(dragDir === 'up'    && isDragging) ? Math.min(1, (dragDist - SWIPE_HINT) / (SWIPE_COMMIT - SWIPE_HINT)) : 0} />
              <SwipeEdge dir="down"  label={swipeMap.down}  active={dragDir === 'down'}  committed={committed && dragDir === 'down'}  opacity={(dragDir === 'down'  && isDragging) ? Math.min(1, (dragDist - SWIPE_HINT) / (SWIPE_COMMIT - SWIPE_HINT)) : 0} />

              {/* Ion image card — key={current.id} forces a fresh DOM element per ion so
                  React never reuses the element from the previous card's fly-off animation.
                  Tap cycles through available reference layers (TIC, fluorescence, overlay). */}
              <div
                key={current.id}
                {...bind()}
                className={`absolute inset-0 rounded-xl overflow-hidden shadow-2xl${!isDragging && !anim ? ' animate-fade-in' : ''}`}
                style={cardStyle}
                onClick={() => { if (!isDragging) cycleLayer() }}
              >
                {/* Ion image (default layer) */}
                {currentLayer === 'ion' && (
                  <img
                    src={current.image_url}
                    alt={`Ion m/z ${current.mz_value}`}
                    className="w-full h-full block"
                    style={{ imageRendering: 'pixelated' }}
                    draggable={false}
                  />
                )}

                {/* TIC spectrum */}
                {currentLayer === 'tic' && (
                  <img
                    src={current.tic_image_url!}
                    alt="TIC spectrum"
                    className="w-full h-full block object-contain"
                    draggable={false}
                  />
                )}

                {/* Fluorescence image (proportional resize, centered) */}
                {currentLayer === 'fluorescence' && (
                  <img
                    src={dataset?.fluorescence_url!}
                    alt="Fluorescence"
                    className="w-full h-full block object-contain"
                    draggable={false}
                  />
                )}

                {/* Overlay: ion image with transparent-PNG fluorescence outline on top. */}
                {currentLayer === 'overlay' && (
                  <div className="absolute inset-0">
                    <img
                      src={current.image_url}
                      alt={`Ion m/z ${current.mz_value}`}
                      className="w-full h-full block object-contain"
                      style={{ imageRendering: 'pixelated' }}
                      draggable={false}
                    />
                    <img
                      src={dataset?.fluorescence_outline_url!}
                      alt="Fluorescence outline"
                      className="absolute inset-0 w-full h-full block object-contain"
                      draggable={false}
                    />
                  </div>
                )}

                {/* Star badge */}
                {current.is_starred && (
                  <div className="absolute top-2 right-2 text-yellow-400 text-lg drop-shadow">★</div>
                )}

                {/* Layer indicator — dots + label, shown only when multiple layers exist */}
                {availableLayers.length > 1 && (
                  <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-20 flex flex-col items-center gap-1 pointer-events-none">
                    <div className="flex gap-1.5">
                      {availableLayers.map((_, i) => (
                        <div
                          key={i}
                          className={`w-1.5 h-1.5 rounded-full transition-colors ${i === layerIndex ? 'bg-white' : 'bg-white/30'}`}
                        />
                      ))}
                    </div>
                    <span className="text-xs text-white/80 bg-black/50 rounded-full px-2 py-0.5 whitespace-nowrap">
                      {LAYER_NAMES[currentLayer]}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Label buttons */}
            <div className="mt-3 flex flex-wrap justify-center gap-2 max-w-lg flex-shrink-0">
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
            <div className="mt-2 flex items-center gap-4 flex-shrink-0">
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
                disabled={undoStack.length === 0}
                className="flex items-center gap-1.5 rounded-lg bg-gray-800 px-4 py-2 text-sm font-medium text-gray-400 hover:text-white hover:bg-gray-700 disabled:opacity-30 transition-colors"
                title="Undo (Z)"
              >
                ↩ Undo
                <kbd className="rounded bg-black/20 px-1 py-0.5 text-xs">Z</kbd>
              </button>
            </div>

            {/* Hint text */}
            {!isDragging && (
              <p className="mt-2 text-xs text-gray-600 flex-shrink-0">
                {availableLayers.length > 1 && 'Tap image to cycle layers · '}
                {Object.keys(swipeMap).length > 0 ? 'Swipe' : 'Press key'} to annotate · S to star · Z to undo
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
