import { useState, useRef } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import apiClient from '../lib/apiClient'
import type { Dataset, LabelOption, Project } from '../lib/types'

const LABEL_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#ef4444',
  '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6',
]

export default function ProjectDetailPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const queryClient = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)

  const [newLabel, setNewLabel] = useState('')
  const [newLabelColor, setNewLabelColor] = useState(LABEL_COLORS[0])
  const [newShortcut, setNewShortcut] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [datasetName, setDatasetName] = useState('')
  const [datasetDesc, setDatasetDesc] = useState('')
  const [sampleType, setSampleType] = useState('')

  const { data: project, isLoading } = useQuery<Project>({
    queryKey: ['project', projectId],
    queryFn: () => apiClient.get(`/api/projects/${projectId}`).then((r) => r.data),
  })

  const { data: datasets } = useQuery<Dataset[]>({
    queryKey: ['datasets', projectId],
    queryFn: () =>
      apiClient.get(`/api/projects/${projectId}/datasets`).then((r) => r.data),
    enabled: !!projectId,
  })

  const addLabel = useMutation({
    mutationFn: (body: { name: string; color: string; keyboard_shortcut?: string }) =>
      apiClient.post(`/api/projects/${projectId}/labels`, body).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] })
      setNewLabel('')
      setNewShortcut('')
    },
  })

  const deleteLabel = useMutation({
    mutationFn: (labelId: string) =>
      apiClient.delete(`/api/labels/${labelId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['project', projectId] }),
  })

  const handleUpload = async () => {
    const file = fileRef.current?.files?.[0]
    if (!file || !datasetName.trim()) return
    setUploading(true)
    setUploadError(null)
    const form = new FormData()
    form.append('project_id', projectId!)
    form.append('name', datasetName)
    if (datasetDesc) form.append('description', datasetDesc)
    if (sampleType) form.append('sample_type', sampleType)
    form.append('file', file)
    try {
      await apiClient.post('/api/datasets/upload', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      queryClient.invalidateQueries({ queryKey: ['datasets', projectId] })
      setDatasetName('')
      setDatasetDesc('')
      setSampleType('')
      if (fileRef.current) fileRef.current.value = ''
    } catch (err: any) {
      setUploadError(err.response?.data?.detail || 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  if (isLoading) {
    return <div className="flex h-screen items-center justify-center text-gray-500">Loading…</div>
  }

  return (
    <div className="min-h-screen bg-gray-950">
      <header className="border-b border-gray-800 bg-gray-900 px-6 py-4 flex items-center gap-4">
        <Link to="/projects" className="text-gray-400 hover:text-white">← Projects</Link>
        <h1 className="text-xl font-bold text-white">{project?.name}</h1>
        <div className="ml-auto flex gap-3">
          <Link
            to={`/projects/${projectId}/stats`}
            className="text-sm text-gray-400 hover:text-white transition-colors"
          >
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
                          <span className={` · ${ds.status === 'error' ? 'text-red-400' : 'text-yellow-400'}`}>
                            {ds.status}
                          </span>
                        )}
                      </p>
                      {ds.error_msg && <p className="text-xs text-red-400 mt-1">{ds.error_msg}</p>}
                    </div>
                    {ds.status === 'ready' && (
                      <Link
                        to={`/projects/${projectId}/annotate?dataset=${ds.id}`}
                        className={`rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors ${done ? 'bg-gray-700 hover:bg-gray-600' : 'bg-brand-orange hover:bg-brand-red'}`}
                      >
                        {done ? 'Review' : 'Annotate'}
                      </Link>
                    )}
                  </div>
                  {ds.status === 'ready' && (
                    <div className="mt-2">
                      <div className="flex justify-between text-xs text-gray-500 mb-1">
                        <span>Your annotations</span>
                        <span>{ds.my_annotation_count} / {ds.total_ions} ({pct}%)</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-gray-800">
                        <div
                          className="h-1.5 rounded-full bg-brand-orange transition-all duration-500"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* Upload new dataset */}
          <div className="mt-4 rounded-xl bg-gray-900 p-5 space-y-3">
            <h3 className="font-medium text-white">Upload dataset (ZIP)</h3>
            <input
              value={datasetName}
              onChange={(e) => setDatasetName(e.target.value)}
              placeholder="Dataset name *"
              className="w-full rounded-lg bg-gray-800 px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <div className="flex gap-3">
              <input
                value={sampleType}
                onChange={(e) => setSampleType(e.target.value)}
                placeholder="Sample type (e.g. mouse brain)"
                className="flex-1 rounded-lg bg-gray-800 px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <input
                value={datasetDesc}
                onChange={(e) => setDatasetDesc(e.target.value)}
                placeholder="Description"
                className="flex-1 rounded-lg bg-gray-800 px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <input ref={fileRef} type="file" accept=".zip" className="text-sm text-gray-400" />
            {uploadError && <p className="text-sm text-red-400">{uploadError}</p>}
            <button
              onClick={handleUpload}
              disabled={uploading || !datasetName.trim()}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
            >
              {uploading ? 'Uploading…' : 'Upload'}
            </button>
          </div>
        </section>

        {/* Labels */}
        <section>
          <h2 className="mb-4 text-lg font-semibold text-white">Labels</h2>
          <div className="space-y-2">
            {project?.label_options.map((label) => (
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
                <button
                  onClick={() => deleteLabel.mutate(label.id)}
                  className="text-gray-600 hover:text-red-400 transition-colors text-sm"
                  title="Delete label"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>

          {/* Add label */}
          <div className="mt-3 flex gap-2 flex-wrap items-center">
            <input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newLabel.trim()) {
                  addLabel.mutate({ name: newLabel.trim(), color: newLabelColor, keyboard_shortcut: newShortcut || undefined })
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
                  addLabel.mutate({ name: newLabel.trim(), color: newLabelColor, keyboard_shortcut: newShortcut || undefined })
                }
              }}
              disabled={!newLabel.trim() || addLabel.isPending}
              className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
            >
              Add
            </button>
          </div>
        </section>
      </main>
    </div>
  )
}
