import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import apiClient from '../lib/apiClient'
import type { Project, StatsOut } from '../lib/types'

export default function StatsPage() {
  const { projectId } = useParams<{ projectId: string }>()

  const { data: project } = useQuery<Project>({
    queryKey: ['project', projectId],
    queryFn: () => apiClient.get(`/api/projects/${projectId}`).then((r) => r.data),
  })

  const { data: stats, isLoading } = useQuery<StatsOut>({
    queryKey: ['stats', projectId],
    queryFn: () => apiClient.get(`/api/projects/${projectId}/stats`).then((r) => r.data),
  })

  const handleExport = (format: 'csv' | 'json') => {
    apiClient
      .get(`/api/projects/${projectId}/annotations`, {
        params: { format },
        responseType: 'blob',
      })
      .then((r) => {
        const url = URL.createObjectURL(r.data)
        const a = document.createElement('a')
        a.href = url
        const safeName = (project?.name ?? projectId)!.replace(/\s+/g, '_')
        a.download = `peakme_${safeName}_annotations.${format}`
        a.click()
        URL.revokeObjectURL(url)
      })
  }

  return (
    <div className="min-h-screen bg-gray-950">
      <header className="border-b border-gray-800 bg-gray-900 px-6 py-4 flex items-center gap-4">
        <Link to={`/projects/${projectId}`} className="text-gray-400 hover:text-white">
          ← {project?.name ?? 'Project'}
        </Link>
        <h1 className="text-xl font-bold text-white">Statistics</h1>
        <div className="ml-auto flex gap-2">
          <button
            onClick={() => handleExport('csv')}
            className="rounded-lg bg-gray-800 px-3 py-1.5 text-sm text-gray-300 hover:text-white hover:bg-gray-700 transition-colors"
          >
            Export CSV
          </button>
          <button
            onClick={() => handleExport('json')}
            className="rounded-lg bg-gray-800 px-3 py-1.5 text-sm text-gray-300 hover:text-white hover:bg-gray-700 transition-colors"
          >
            Export JSON
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-10 space-y-8">
        {isLoading ? (
          <div className="flex justify-center py-20">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
          </div>
        ) : stats ? (
          <>
            {/* Summary */}
            <div className="grid grid-cols-3 gap-4">
              <Stat label="Total ions" value={stats.total_ions.toLocaleString()} />
              <Stat label="Total annotations" value={stats.total_annotations.toLocaleString()} />
              <Stat label="Annotators" value={stats.unique_annotators.toString()} />
            </div>

            {/* Per-user breakdown */}
            <section>
              <h2 className="mb-4 text-lg font-semibold text-white">Per annotator</h2>
              <div className="space-y-4">
                {stats.per_user.map((u) => (
                  <div key={u.user_id} className="rounded-xl bg-gray-900 p-5">
                    <div className="flex items-center justify-between mb-3">
                      <p className="font-semibold text-white">{u.display_name}</p>
                      <p className="text-sm text-gray-400">{u.annotation_count.toLocaleString()} annotations</p>
                    </div>
                    {/* Progress bar */}
                    <div className="mb-3 h-2 rounded-full bg-gray-800 overflow-hidden">
                      <div
                        className="h-2 rounded-full bg-indigo-500"
                        style={{ width: `${Math.min(100, (u.annotation_count / (stats.total_ions || 1)) * 100)}%` }}
                      />
                    </div>
                    {/* Label breakdown */}
                    <div className="flex flex-wrap gap-2">
                      {u.label_breakdown.map((lb) => {
                        const labelOption = project?.label_options.find((l) => l.name === lb.label_name)
                        return (
                          <span
                            key={lb.label_name}
                            className="rounded-full px-2.5 py-0.5 text-xs font-medium text-white"
                            style={{ backgroundColor: labelOption?.color || '#6366f1' }}
                          >
                            {lb.label_name}: {lb.count}
                          </span>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </>
        ) : null}
      </main>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-gray-900 p-5 text-center">
      <p className="text-3xl font-bold text-white">{value}</p>
      <p className="mt-1 text-sm text-gray-400">{label}</p>
    </div>
  )
}
