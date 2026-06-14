import { useState, useRef, type ChangeEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import apiClient from '../lib/apiClient'
import type { Dataset, DatasetLabelSummary, LabelOption, Project } from '../lib/types'

const LABEL_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#ef4444',
  '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6',
]

type SwipeDir = 'left' | 'right' | 'up' | 'down'
const SWIPE_DIRS: SwipeDir[] = ['left', 'right', 'up', 'down']
const DIR_ARROW: Record<SwipeDir, string> = { left: '←', right: '→', up: '↑', down: '↓' }

// prepare-upload/ingest/cleanup are quick DB ops, but on a busy backend they
// queue behind in-flight ingestions. Give them a longer timeout than the
// default 10s (which is tuned for fast-failing read queries).
const UPLOAD_API_TIMEOUT = 60000

// Max time to wait for a single dataset to finish ingesting before moving on.
const INGEST_WAIT_MS = 15 * 60 * 1000

type QueueStatus = 'queued' | 'uploading' | 'processing' | 'done' | 'error'
type QueueItem = {
  id: string
  file: File
  name: string
  status: QueueStatus
  progress: number
  ingestPct?: number
  error?: string
}

const stripZip = (filename: string) => filename.replace(/\.zip$/i, '')

function DirectionPicker({
  value,
  onChange,
  usedDirs,
}: {
  value: SwipeDir | null
  onChange: (d: SwipeDir | null) => void
  usedDirs: SwipeDir[]
}) {
  return (
    <div className="flex items-center gap-1" title="Assign swipe direction (optional)">
      {SWIPE_DIRS.map((d) => {
        const isMine = value === d
        const blocked = !isMine && usedDirs.includes(d)
        return (
          <button
            key={d}
            type="button"
            disabled={blocked}
            onClick={() => onChange(isMine ? null : d)}
            className={`w-7 h-7 rounded text-sm font-bold transition-all
              ${isMine ? 'bg-brand-orange text-white ring-2 ring-white' : blocked ? 'bg-gray-800 text-gray-600 cursor-not-allowed' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'}`}
            title={blocked ? `Already used by another label` : `Swipe ${d}`}
          >
            {DIR_ARROW[d]}
          </button>
        )
      })}
    </div>
  )
}

function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="flex gap-1.5">
      {LABEL_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          className={`h-5 w-5 rounded-full transition-transform ${value === c ? 'scale-125 ring-2 ring-white' : ''}`}
          style={{ backgroundColor: c }}
        />
      ))}
    </div>
  )
}

export default function ProjectDetailPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const queryClient = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)

  // new label form
  const [newLabel, setNewLabel] = useState('')
  const [newLabelColor, setNewLabelColor] = useState(LABEL_COLORS[0])
  const [newShortcut, setNewShortcut] = useState('')
  const [newSwipeDir, setNewSwipeDir] = useState<SwipeDir | null>(null)

  // inline label editing
  const [editingId, setEditingId] = useState<string | null>(null)
  const [confirmDeleteDatasetId, setConfirmDeleteDatasetId] = useState<string | null>(null)
  const [refOpen, setRefOpen] = useState<Record<string, boolean>>({})
  const [refUploading, setRefUploading] = useState<Record<string, 'fluorescence' | 'outline' | null>>({})
  const [refError, setRefError] = useState<Record<string, string | null>>({})
  const fluorRefs = useRef<Record<string, HTMLInputElement | null>>({})
  const outlineRefs = useRef<Record<string, HTMLInputElement | null>>({})
  const [editName, setEditName] = useState('')
  const [editColor, setEditColor] = useState('')
  const [editShortcut, setEditShortcut] = useState('')

  // upload queue — datasets upload AND ingest one at a time so the backend is
  // never hit with parallel ingestions (which saturate the small EC2 box).
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [running, setRunning] = useState(false)
  const [datasetDesc, setDatasetDesc] = useState('')
  const [sampleType, setSampleType] = useState('')

  const { data: project, isLoading } = useQuery<Project>({
    queryKey: ['project', projectId],
    queryFn: () => apiClient.get(`/api/projects/${projectId}`).then((r) => r.data),
  })

  const { data: datasets } = useQuery<Dataset[]>({
    queryKey: ['datasets', projectId],
    queryFn: () => apiClient.get(`/api/projects/${projectId}/datasets`).then((r) => r.data),
    enabled: !!projectId,
    refetchOnWindowFocus: true,
    refetchInterval: (query) => {
      const data = query.state.data
      return data?.some((d) => d.status === 'processing' || d.status === 'pending') ? 3000 : false
    },
  })

  const readyDatasetIds = (datasets ?? []).filter((d) => d.status === 'ready').map((d) => d.id)
  const labelSummaryResults = useQueries({
    queries: readyDatasetIds.map((id) => ({
      queryKey: ['dataset-label-summary', id],
      queryFn: () => apiClient.get<DatasetLabelSummary>(`/api/datasets/${id}/label-summary`).then((r) => r.data),
    })),
  })
  const labelSummaries: Record<string, DatasetLabelSummary> = Object.fromEntries(
    readyDatasetIds.map((id, i) => [id, labelSummaryResults[i].data as DatasetLabelSummary]).filter(([, v]) => v)
  )

  const addLabel = useMutation({
    mutationFn: (body: { name: string; color: string; keyboard_shortcut?: string; swipe_direction?: SwipeDir }) =>
      apiClient.post(`/api/projects/${projectId}/labels`, body).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] })
      setNewLabel('')
      setNewShortcut('')
      setNewSwipeDir(null)
    },
  })

  const updateLabel = useMutation({
    mutationFn: ({ id, ...body }: { id: string; name?: string; color?: string; keyboard_shortcut?: string; swipe_direction?: SwipeDir | null }) =>
      apiClient.patch(`/api/labels/${id}`, body).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] })
      setEditingId(null)
    },
  })

  const deleteLabel = useMutation({
    mutationFn: (labelId: string) => apiClient.delete(`/api/labels/${labelId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['project', projectId] }),
  })

  const deleteDataset = useMutation({
    mutationFn: (datasetId: string) => apiClient.delete(`/api/datasets/${datasetId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['datasets', projectId] }),
  })

  const updateItem = (id: string, patch: Partial<QueueItem>) =>
    setQueue((q) => q.map((it) => (it.id === id ? { ...it, ...patch } : it)))

  const removeItem = (id: string) => setQueue((q) => q.filter((it) => it.id !== id))

  const handleFilesSelected = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    if (files.length === 0) return
    setQueue(
      files.map((f, i) => ({
        id: `${Date.now()}-${i}-${f.name}`,
        file: f,
        name: stripZip(f.name),
        status: 'queued' as QueueStatus,
        progress: 0,
      }))
    )
  }

  // Poll until ingestion finishes so the next dataset doesn't start ingesting
  // in parallel (which is what saturates the backend). Generous cap; if exceeded
  // we stop waiting and move on rather than blocking the queue forever.
  const waitForIngest = async (datasetId: string, itemId: string): Promise<'ready' | 'error'> => {
    const deadline = Date.now() + INGEST_WAIT_MS
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000))
      try {
        const { data } = await apiClient.get<Dataset>(`/api/datasets/${datasetId}`, { timeout: UPLOAD_API_TIMEOUT })
        if (data.total_ions > 0) {
          updateItem(itemId, { ingestPct: Math.min(100, Math.round((data.processed_ions / data.total_ions) * 100)) })
        }
        if (data.status === 'ready') return 'ready'
        if (data.status === 'error') return 'error'
      } catch {
        // transient — keep polling
      }
    }
    return 'ready'
  }

  const pendingCount = queue.filter((it) => it.status === 'queued' || it.status === 'error').length

  const runQueue = async () => {
    const pending = queue.filter((it) => it.status === 'queued' || it.status === 'error')
    if (pending.length === 0) return
    setRunning(true)
    for (const item of pending) {
      let datasetId: string | null = null
      try {
        updateItem(item.id, { status: 'uploading', progress: 0, error: undefined })

        // Step 1: create DB record + get presigned S3 URL
        const { data } = await apiClient.post('/api/datasets/prepare-upload', {
          project_id: projectId,
          name: item.name.trim() || stripZip(item.file.name),
          description: datasetDesc || undefined,
          sample_type: sampleType || undefined,
        }, { timeout: UPLOAD_API_TIMEOUT })
        const dsId: string = data.dataset_id
        datasetId = dsId

        // Step 2: upload directly to S3 — Content-Type must match the signed URL
        await axios.put(data.upload_url, item.file, {
          headers: { 'Content-Type': 'application/zip' },
          onUploadProgress: (e) => {
            if (e.total) updateItem(item.id, { progress: Math.round((e.loaded / e.total) * 100) })
          },
        })

        // Step 3: trigger ingestion, then wait for it to finish before the next
        updateItem(item.id, { status: 'processing', progress: 100 })
        await apiClient.post(`/api/datasets/${dsId}/ingest`, undefined, { timeout: UPLOAD_API_TIMEOUT })
        queryClient.invalidateQueries({ queryKey: ['datasets', projectId] })

        const result = await waitForIngest(dsId, item.id)
        updateItem(item.id, result === 'ready'
          ? { status: 'done' }
          : { status: 'error', error: 'Ingestion failed — see dataset for details' })
      } catch (err: any) {
        // Clean up the orphaned pending record if upload or ingest call failed
        if (datasetId) {
          try { await apiClient.delete(`/api/datasets/${datasetId}`, { timeout: UPLOAD_API_TIMEOUT }) } catch { /* best-effort cleanup; ignore */ }
        }
        updateItem(item.id, { status: 'error', error: err.response?.data?.detail || err.message || 'Upload failed' })
      }
      queryClient.invalidateQueries({ queryKey: ['datasets', projectId] })
    }
    setRunning(false)
  }

  const handleExport = (format: 'csv' | 'json', dsId?: string, dsName?: string) => {
    const url = dsId
      ? `/api/projects/${projectId}/datasets/${dsId}/annotations`
      : `/api/projects/${projectId}/annotations`
    const safeName = (dsName ?? project?.name ?? projectId)!.replace(/\s+/g, '_')
    apiClient.get(url, { params: { format }, responseType: 'blob' }).then((r) => {
      const blobUrl = URL.createObjectURL(r.data)
      const a = document.createElement('a')
      a.href = blobUrl
      a.download = `peakme_${safeName}_annotations.${format}`
      a.click()
      URL.revokeObjectURL(blobUrl)
    })
  }

  const handleRefUpload = async (datasetId: string, type: 'fluorescence' | 'outline') => {
    const input = type === 'fluorescence' ? fluorRefs.current[datasetId] : outlineRefs.current[datasetId]
    const file = input?.files?.[0]
    if (!file) return
    setRefUploading((prev) => ({ ...prev, [datasetId]: type }))
    setRefError((prev) => ({ ...prev, [datasetId]: null }))
    const form = new FormData()
    form.append(type === 'fluorescence' ? 'fluorescence' : 'outline', file)
    try {
      await apiClient.patch(`/api/datasets/${datasetId}/reference-images`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      queryClient.invalidateQueries({ queryKey: ['datasets', projectId] })
      if (input) input.value = ''
    } catch (err: any) {
      setRefError((prev) => ({ ...prev, [datasetId]: err.response?.data?.detail || 'Upload failed' }))
    } finally {
      setRefUploading((prev) => ({ ...prev, [datasetId]: null }))
    }
  }

  const startEdit = (label: LabelOption) => {
    setEditingId(label.id)
    setEditName(label.name)
    setEditColor(label.color || LABEL_COLORS[0])
    setEditShortcut(label.keyboard_shortcut || '')
  }

  const usedDirs = (project?.label_options ?? [])
    .map((l) => l.swipe_direction)
    .filter(Boolean) as SwipeDir[]

  if (isLoading) {
    return <div className="flex h-screen items-center justify-center text-gray-500">Loading…</div>
  }

  return (
    <div className="min-h-screen bg-gray-950">
      <header className="border-b border-gray-800 bg-gray-900 px-6 py-4 flex items-center gap-4">
        <Link to="/projects" className="text-gray-400 hover:text-white">← Projects</Link>
        <h1 className="text-xl font-bold text-white">{project?.name}</h1>
        <div className="ml-auto flex items-center gap-3">
          <button
            onClick={() => handleExport('csv')}
            className="rounded-lg bg-gray-800 px-3 py-1.5 text-sm text-gray-300 hover:text-white hover:bg-gray-700 transition-colors"
          >
            Export CSV
          </button>
          <Link to={`/projects/${projectId}/stats`} className="text-sm text-gray-400 hover:text-white transition-colors">
            Stats
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-10 space-y-10">

        {/* Datasets */}
        <section>
          <h2 className="mb-4 text-lg font-semibold text-white">Datasets</h2>
          <div className="space-y-3">
            {datasets?.map((ds) => {
              const pct = ds.total_ions > 0 ? Math.round((ds.my_annotation_count / ds.total_ions) * 100) : 0
              const done = ds.my_annotation_count >= ds.total_ions && ds.total_ions > 0
              return (
                <div key={ds.id} className="rounded-xl bg-gray-900 p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <p className="font-medium text-white">{ds.name}</p>
                      <p className="text-sm text-gray-400">
                        {ds.total_ions.toLocaleString()} ions
                        {ds.sample_type && ` · ${ds.sample_type}`}
                        {ds.status !== 'ready' && (
                          <span className={` · ${ds.status === 'error' ? 'text-red-400' : 'text-yellow-400 animate-pulse'}`}>
                            {ds.status === 'processing'
                              ? (ds.total_ions > 0
                                  ? `processing ions… ${Math.round((ds.processed_ions / ds.total_ions) * 100)}%`
                                  : 'processing ions…')
                              : ds.status}
                          </span>
                        )}
                      </p>
                      {ds.error_msg && <p className="text-xs text-red-400 mt-1">{ds.error_msg}</p>}
                    </div>
                    <div className="flex items-center gap-2">
                      {ds.status === 'ready' && (
                        <>
                          <button
                            onClick={() => handleExport('csv', ds.id, ds.name)}
                            className="rounded-lg bg-gray-800 px-2.5 py-1.5 text-xs text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
                            title="Export annotations as CSV"
                          >
                            ↓ CSV
                          </button>
                          <Link
                            to={`/projects/${projectId}/annotate?dataset=${ds.id}`}
                            className={`rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors ${done ? 'bg-gray-700 hover:bg-gray-600' : 'bg-brand-orange hover:bg-brand-red'}`}
                          >
                            {done ? 'Review' : 'Annotate'}
                          </Link>
                        </>
                      )}
                      {confirmDeleteDatasetId === ds.id ? (
                        <div className="flex items-center gap-1.5 text-xs">
                          <span className="text-gray-400">Delete?</span>
                          <button
                            onClick={() => { deleteDataset.mutate(ds.id); setConfirmDeleteDatasetId(null) }}
                            className="rounded px-2 py-0.5 bg-red-600 text-white hover:bg-red-500 transition-colors"
                          >Yes</button>
                          <button
                            onClick={() => setConfirmDeleteDatasetId(null)}
                            className="rounded px-2 py-0.5 bg-gray-700 text-gray-300 hover:bg-gray-600 transition-colors"
                          >No</button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmDeleteDatasetId(ds.id)}
                          className="text-gray-600 hover:text-red-400 transition-colors text-sm"
                          title="Delete dataset"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  </div>
                  {ds.status === 'ready' && (
                    <>
                      <div className="mt-2">
                        <div className="flex justify-between text-xs text-gray-500 mb-1">
                          <span>Your annotations</span>
                          <span>{ds.my_annotation_count.toLocaleString()} / {ds.total_ions.toLocaleString()} ({pct}%)</span>
                        </div>
                        <div className="h-1.5 rounded-full bg-gray-800">
                          <div
                            className="h-1.5 rounded-full bg-brand-orange transition-all duration-500"
                            style={{ width: `${pct}%` }}
                          />
                        </div>

                        {/* Per-label breakdown */}
                        {labelSummaries[ds.id]?.labels.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {labelSummaries[ds.id].labels.map((lb) => {
                              const color = project?.label_options.find((l) => l.name === lb.label_name)?.color ?? '#6366f1'
                              return (
                                <span
                                  key={lb.label_name}
                                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs text-white"
                                  style={{ backgroundColor: color + '33', border: `1px solid ${color}66` }}
                                  title={`${lb.count.toLocaleString()} ions`}
                                >
                                  <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
                                  {lb.label_name}
                                  <span className="opacity-70">{lb.pct}%</span>
                                </span>
                              )
                            })}
                            {labelSummaries[ds.id].unannotated > 0 && (
                              <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs text-gray-500 border border-gray-700">
                                <span className="w-1.5 h-1.5 rounded-full bg-gray-600 flex-shrink-0" />
                                unannotated
                                <span className="opacity-70">{Math.round(labelSummaries[ds.id].unannotated / labelSummaries[ds.id].total * 100)}%</span>
                              </span>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Reference images (fluorescence + outline) */}
                      <div className="mt-2 pt-2 border-t border-gray-800">
                        <button
                          onClick={() => setRefOpen((prev) => ({ ...prev, [ds.id]: !prev[ds.id] }))}
                          className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-400 transition-colors"
                        >
                          <span>{refOpen[ds.id] ? '▾' : '▸'} Reference images</span>
                          {(ds.fluorescence_url || ds.fluorescence_outline_url) && (
                            <span className="text-green-400" title="Reference images uploaded">●</span>
                          )}
                        </button>
                        {refOpen[ds.id] && (
                          <div className="mt-2 grid grid-cols-2 gap-3">
                            {(['fluorescence', 'outline'] as const).map((type) => {
                              const isSet = type === 'fluorescence' ? !!ds.fluorescence_url : !!ds.fluorescence_outline_url
                              const label = type === 'fluorescence' ? 'Fluorescence image' : 'Outline PNG'
                              const accept = type === 'fluorescence' ? 'image/*' : 'image/png'
                              const refs = type === 'fluorescence' ? fluorRefs : outlineRefs
                              return (
                                <div key={type}>
                                  <p className="text-xs text-gray-400 mb-1 flex items-center gap-1">
                                    {label}
                                    {isSet && <span className="text-green-400 text-xs">✓</span>}
                                  </p>
                                  <div className="flex gap-1.5 items-center">
                                    <input
                                      ref={(el) => { refs.current[ds.id] = el }}
                                      type="file"
                                      accept={accept}
                                      className="text-xs text-gray-400 flex-1 min-w-0"
                                    />
                                    <button
                                      onClick={() => handleRefUpload(ds.id, type)}
                                      disabled={refUploading[ds.id] === type}
                                      className="rounded px-2 py-1 text-xs bg-gray-700 text-gray-300 hover:bg-gray-600 disabled:opacity-50 whitespace-nowrap transition-colors"
                                    >
                                      {refUploading[ds.id] === type ? '…' : isSet ? 'Replace' : 'Upload'}
                                    </button>
                                  </div>
                                </div>
                              )
                            })}
                            {refError[ds.id] && (
                              <p className="col-span-2 text-xs text-red-400">{refError[ds.id]}</p>
                            )}
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )
            })}
          </div>

          {/* Upload datasets */}
          <div className="mt-4 rounded-xl bg-gray-900 p-5 space-y-3">
            <h3 className="font-medium text-white">Upload datasets (ZIP)</h3>
            <p className="text-xs text-gray-500">
              Select one or more ZIPs. Each becomes a dataset named after its file. They upload and ingest one at a time so the server isn't overloaded.
            </p>
            <div className="flex flex-col sm:flex-row gap-3">
              <input
                value={sampleType}
                onChange={(e) => setSampleType(e.target.value)}
                placeholder="Sample type (applies to all)"
                className="min-w-0 flex-1 rounded-lg bg-gray-800 px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <input
                value={datasetDesc}
                onChange={(e) => setDatasetDesc(e.target.value)}
                placeholder="Description (applies to all)"
                className="min-w-0 flex-1 rounded-lg bg-gray-800 px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".zip"
              multiple
              onChange={handleFilesSelected}
              disabled={running}
              className="text-sm text-gray-400 disabled:opacity-50"
            />

            {queue.length > 0 && (
              <div className="space-y-1.5">
                {queue.map((item) => (
                  <div key={item.id} className="flex items-center gap-2 rounded-lg bg-gray-800 px-3 py-2">
                    <input
                      value={item.name}
                      onChange={(e) => updateItem(item.id, { name: e.target.value })}
                      disabled={running || (item.status !== 'queued' && item.status !== 'error')}
                      className="min-w-0 flex-1 rounded bg-gray-900 px-2 py-1 text-sm text-white disabled:opacity-60 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    />
                    <div className="w-44 flex-shrink-0">
                      {item.status === 'queued' && <span className="text-xs text-gray-500">queued</span>}
                      {item.status === 'uploading' && (
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 flex-1 rounded-full bg-gray-700">
                            <div className="h-1.5 rounded-full bg-indigo-500 transition-all" style={{ width: `${item.progress}%` }} />
                          </div>
                          <span className="w-9 text-right text-xs text-gray-400">{item.progress}%</span>
                        </div>
                      )}
                      {item.status === 'processing' && (
                        item.ingestPct != null ? (
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 flex-1 rounded-full bg-gray-700">
                              <div className="h-1.5 rounded-full bg-brand-orange transition-all" style={{ width: `${item.ingestPct}%` }} />
                            </div>
                            <span className="w-12 text-right text-xs text-gray-400">{item.ingestPct}%</span>
                          </div>
                        ) : (
                          <span className="text-xs text-yellow-400 animate-pulse">ingesting…</span>
                        )
                      )}
                      {item.status === 'done' && <span className="text-xs text-green-400">✓ ready</span>}
                      {item.status === 'error' && <span className="block truncate text-xs text-red-400" title={item.error}>✕ {item.error}</span>}
                    </div>
                    {!running && (item.status === 'queued' || item.status === 'error') && (
                      <button
                        onClick={() => removeItem(item.id)}
                        className="flex-shrink-0 text-sm text-gray-600 hover:text-red-400 transition-colors"
                        title="Remove from queue"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            <button
              onClick={runQueue}
              disabled={running || pendingCount === 0}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
            >
              {running ? 'Uploading…' : `Upload ${pendingCount} dataset${pendingCount === 1 ? '' : 's'}`}
            </button>
          </div>
        </section>

        {/* Labels */}
        <section>
          <h2 className="mb-4 text-lg font-semibold text-white">Labels</h2>

          <div className="space-y-2">
            {project?.label_options.map((label) => {
              const otherDirs = (project.label_options ?? [])
                .filter((l) => l.id !== label.id)
                .map((l) => l.swipe_direction)
                .filter(Boolean) as SwipeDir[]

              if (editingId === label.id) {
                return (
                  <div key={label.id} className="rounded-lg bg-gray-900 px-4 py-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="flex-1 rounded bg-gray-800 px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        autoFocus
                      />
                      <input
                        value={editShortcut}
                        onChange={(e) => setEditShortcut(e.target.value.slice(0, 1))}
                        placeholder="Key"
                        maxLength={1}
                        className="w-12 rounded bg-gray-800 px-2 py-1.5 text-sm text-white text-center focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                      <DirectionPicker
                        value={label.swipe_direction}
                        usedDirs={otherDirs}
                        onChange={(d) => updateLabel.mutate({ id: label.id, swipe_direction: d })}
                      />
                    </div>
                    <div className="flex items-center justify-between">
                      <ColorPicker value={editColor} onChange={setEditColor} />
                      <div className="flex gap-2">
                        <button
                          onClick={() => setEditingId(null)}
                          className="rounded px-2 py-1 text-xs text-gray-400 hover:text-white transition-colors"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => updateLabel.mutate({
                            id: label.id,
                            name: editName.trim() || undefined,
                            color: editColor,
                            keyboard_shortcut: editShortcut || undefined,
                          })}
                          disabled={!editName.trim() || updateLabel.isPending}
                          className="rounded bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  </div>
                )
              }

              return (
                <div key={label.id} className="flex items-center gap-3 rounded-lg bg-gray-900 px-4 py-3">
                  <span
                    className="h-4 w-4 rounded-full flex-shrink-0"
                    style={{ backgroundColor: label.color || '#6366f1' }}
                  />
                  <span className="flex-1 text-white">{label.name}</span>
                  {label.keyboard_shortcut && (
                    <kbd className="rounded bg-gray-700 px-1.5 py-0.5 text-xs text-gray-300">
                      {label.keyboard_shortcut}
                    </kbd>
                  )}
                  <DirectionPicker
                    value={label.swipe_direction}
                    usedDirs={otherDirs}
                    onChange={(d) => updateLabel.mutate({ id: label.id, swipe_direction: d })}
                  />
                  <button
                    onClick={() => startEdit(label)}
                    className="rounded px-2 py-0.5 text-xs text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
                    title="Edit label"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => deleteLabel.mutate(label.id)}
                    className="text-gray-600 hover:text-red-400 transition-colors text-sm"
                    title="Delete label"
                  >
                    ✕
                  </button>
                </div>
              )
            })}
          </div>

          {/* Add label */}
          <div className="mt-3 flex gap-2 flex-wrap items-center">
            <input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newLabel.trim()) {
                  addLabel.mutate({ name: newLabel.trim(), color: newLabelColor, keyboard_shortcut: newShortcut || undefined, swipe_direction: newSwipeDir || undefined })
                }
              }}
              placeholder="Label name"
              className="rounded-lg bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <input
              value={newShortcut}
              onChange={(e) => setNewShortcut(e.target.value.slice(0, 1))}
              placeholder="Key"
              maxLength={1}
              className="w-14 rounded-lg bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <DirectionPicker
              value={newSwipeDir}
              usedDirs={usedDirs}
              onChange={setNewSwipeDir}
            />
            <div className="flex gap-1.5">
              {LABEL_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => setNewLabelColor(c)}
                  className={`h-6 w-6 rounded-full transition-transform ${newLabelColor === c ? 'scale-125 ring-2 ring-white' : ''}`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
            <button
              onClick={() => {
                if (newLabel.trim()) {
                  addLabel.mutate({ name: newLabel.trim(), color: newLabelColor, keyboard_shortcut: newShortcut || undefined, swipe_direction: newSwipeDir || undefined })
                }
              }}
              disabled={!newLabel.trim() || addLabel.isPending}
              className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
            >
              Add
            </button>
          </div>
          <p className="mt-2 text-xs text-gray-600">
            ← → ↑ ↓ assign swipe directions · grayed out = already used
          </p>
        </section>
      </main>
    </div>
  )
}
