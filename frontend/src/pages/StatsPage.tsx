import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import apiClient from '../lib/apiClient'
import type { GlobalStatsOut, LabelCount, Project, StatsOut } from '../lib/types'

// Fallback colour palette for labels that have no colour set
const FALLBACK_COLOURS = [
  '#6366f1', '#f59e0b', '#10b981', '#ef4444', '#3b82f6',
  '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#84cc16',
]

function labelColour(
  labelName: string,
  labelOptions: Project['label_options'],
  index: number,
): string {
  const opt = labelOptions.find((l) => l.name === labelName)
  return opt?.color || FALLBACK_COLOURS[index % FALLBACK_COLOURS.length]
}

// ─── Stacked distribution bar ───────────────────────────────────────────────

function DistributionBar({
  distribution,
  labelOptions,
}: {
  distribution: LabelCount[]
  labelOptions: Project['label_options']
}) {
  const total = distribution.reduce((s, l) => s + l.count, 0)

  if (total === 0) {
    return (
      <p className="text-sm text-gray-500 italic py-3">No annotations yet.</p>
    )
  }

  return (
    <div className="space-y-3">
      {/* Stacked bar */}
      <div className="flex h-5 w-full overflow-hidden rounded-full bg-gray-800">
        {distribution.map((lc, i) => (
          <div
            key={lc.label_name}
            title={`${lc.label_name}: ${lc.count}`}
            style={{
              width: `${(lc.count / total) * 100}%`,
              backgroundColor: labelColour(lc.label_name, labelOptions, i),
            }}
          />
        ))}
      </div>
      {/* Legend */}
      <div className="flex flex-wrap gap-2">
        {distribution.map((lc, i) => (
          <span
            key={lc.label_name}
            className="flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium text-white"
            style={{ backgroundColor: labelColour(lc.label_name, labelOptions, i) + '33',
                     border: `1px solid ${labelColour(lc.label_name, labelOptions, i)}` }}
          >
            <span
              className="inline-block h-2 w-2 rounded-full flex-shrink-0"
              style={{ backgroundColor: labelColour(lc.label_name, labelOptions, i) }}
            />
            {lc.label_name}: {lc.count.toLocaleString()} ({((lc.count / total) * 100).toFixed(1)}%)
          </span>
        ))}
      </div>
    </div>
  )
}

// ─── Global distribution bar (no project label_options) ─────────────────────

function GlobalDistributionBar({ distribution }: { distribution: LabelCount[] }) {
  const total = distribution.reduce((s, l) => s + l.count, 0)

  if (total === 0) {
    return <p className="text-sm text-gray-500 italic py-3">No annotations yet.</p>
  }

  return (
    <div className="space-y-3">
      <div className="flex h-5 w-full overflow-hidden rounded-full bg-gray-800">
        {distribution.map((lc, i) => (
          <div
            key={lc.label_name}
            title={`${lc.label_name}: ${lc.count}`}
            style={{
              width: `${(lc.count / total) * 100}%`,
              backgroundColor: FALLBACK_COLOURS[i % FALLBACK_COLOURS.length],
            }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        {distribution.map((lc, i) => (
          <span
            key={lc.label_name}
            className="flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium text-white"
            style={{
              backgroundColor: FALLBACK_COLOURS[i % FALLBACK_COLOURS.length] + '33',
              border: `1px solid ${FALLBACK_COLOURS[i % FALLBACK_COLOURS.length]}`,
            }}
          >
            <span
              className="inline-block h-2 w-2 rounded-full flex-shrink-0"
              style={{ backgroundColor: FALLBACK_COLOURS[i % FALLBACK_COLOURS.length] }}
            />
            {lc.label_name}: {lc.count.toLocaleString()} ({((lc.count / total) * 100).toFixed(1)}%)
          </span>
        ))}
      </div>
    </div>
  )
}

// ─── Main page ───────────────────────────────────────────────────────────────

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

  const { data: globalStats } = useQuery<GlobalStatsOut>({
    queryKey: ['globalStats'],
    queryFn: () => apiClient.get('/api/stats').then((r) => r.data),
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

  const labelOptions = project?.label_options ?? []

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
            {/* ── Section 1: Completion hero ── */}
            <section className="rounded-xl bg-gray-900 p-6 space-y-4">
              <div className="flex items-baseline justify-between flex-wrap gap-2">
                <div>
                  <span className="text-4xl font-bold text-white tabular-nums">
                    {stats.total_annotated_ions.toLocaleString()}
                  </span>
                  <span className="text-2xl text-gray-400 font-medium">
                    {' '}/ {stats.total_ions.toLocaleString()}
                  </span>
                  <p className="text-sm text-gray-400 mt-1">ions annotated</p>
                </div>
                <span className="text-3xl font-bold text-orange-400 tabular-nums">
                  {stats.total_ions > 0
                    ? ((stats.total_annotated_ions / stats.total_ions) * 100).toFixed(1)
                    : '0.0'}%
                </span>
              </div>

              {/* Progress bar */}
              <div className="h-3 w-full rounded-full bg-gray-800 overflow-hidden">
                <div
                  className="h-3 rounded-full bg-orange-500 transition-all duration-500"
                  style={{
                    width: `${stats.total_ions > 0
                      ? Math.min(100, (stats.total_annotated_ions / stats.total_ions) * 100)
                      : 0}%`,
                  }}
                />
              </div>

              {/* Secondary stats */}
              <div className="flex gap-6 pt-1">
                <div>
                  <p className="text-xl font-semibold text-white tabular-nums">
                    {stats.total_annotations.toLocaleString()}
                  </p>
                  <p className="text-xs text-gray-500">total annotations</p>
                </div>
                <div>
                  <p className="text-xl font-semibold text-white tabular-nums">
                    {stats.unique_annotators}
                  </p>
                  <p className="text-xs text-gray-500">annotator{stats.unique_annotators !== 1 ? 's' : ''}</p>
                </div>
              </div>
            </section>

            {/* ── Section 2: Label distribution ── */}
            <section className="rounded-xl bg-gray-900 p-6 space-y-3">
              <h2 className="text-base font-semibold text-white">Label distribution</h2>
              <DistributionBar
                distribution={stats.label_distribution}
                labelOptions={labelOptions}
              />
            </section>

            {/* ── Section 3: Per-annotator cards ── */}
            <section>
              <h2 className="mb-4 text-base font-semibold text-white">Per annotator</h2>
              {stats.per_user.length === 0 ? (
                <p className="text-sm text-gray-500 italic">No annotations yet.</p>
              ) : (
                <div className="space-y-3">
                  {stats.per_user.map((u) => {
                    const pct = stats.total_ions > 0
                      ? ((u.annotation_count / stats.total_ions) * 100).toFixed(1)
                      : '0.0'
                    return (
                      <div key={u.user_id} className="rounded-xl bg-gray-900 p-5">
                        <div className="flex items-center justify-between mb-3">
                          <p className="font-semibold text-white">{u.display_name}</p>
                          <div className="text-right">
                            <p className="text-sm font-medium text-white tabular-nums">
                              {u.annotation_count.toLocaleString()}
                            </p>
                            <p className="text-xs text-gray-500">{pct}% of total ions</p>
                          </div>
                        </div>
                        {/* Progress bar */}
                        <div className="mb-3 h-1.5 rounded-full bg-gray-800 overflow-hidden">
                          <div
                            className="h-1.5 rounded-full bg-indigo-500"
                            style={{
                              width: `${Math.min(100, (u.annotation_count / (stats.total_ions || 1)) * 100)}%`,
                            }}
                          />
                        </div>
                        {/* Label breakdown pills */}
                        <div className="flex flex-wrap gap-1.5">
                          {u.label_breakdown.map((lb, i) => (
                            <span
                              key={lb.label_name}
                              className="rounded-full px-2.5 py-0.5 text-xs font-medium text-white"
                              style={{
                                backgroundColor:
                                  labelColour(lb.label_name, labelOptions, i),
                              }}
                            >
                              {lb.label_name}: {lb.count}
                            </span>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </section>

            {/* ── Section 4: PeakMe Community ── */}
            <div className="relative py-4">
              <div className="absolute inset-0 flex items-center" aria-hidden="true">
                <div className="w-full border-t border-gray-800" />
              </div>
              <div className="relative flex justify-center">
                <span className="bg-gray-950 px-4 text-xs text-gray-500 uppercase tracking-widest">
                  PeakMe Community
                </span>
              </div>
            </div>

            {globalStats ? (
              <section className="rounded-xl bg-gray-900 p-6 space-y-5">
                <div>
                  <h2 className="text-base font-semibold text-white">Platform-wide statistics</h2>
                  <p className="text-xs text-gray-500 mt-0.5">Aggregated across all projects and all annotators</p>
                </div>

                <div className="grid grid-cols-3 gap-4">
                  <div className="rounded-lg bg-gray-800 p-4 text-center">
                    <p className="text-2xl font-bold text-white tabular-nums">
                      {globalStats.total_ions.toLocaleString()}
                    </p>
                    <p className="text-xs text-gray-400 mt-1">total ions</p>
                  </div>
                  <div className="rounded-lg bg-gray-800 p-4 text-center">
                    <p className="text-2xl font-bold text-white tabular-nums">
                      {globalStats.total_annotations.toLocaleString()}
                    </p>
                    <p className="text-xs text-gray-400 mt-1">annotations</p>
                  </div>
                  <div className="rounded-lg bg-gray-800 p-4 text-center">
                    <p className="text-2xl font-bold text-white tabular-nums">
                      {globalStats.unique_annotators}
                    </p>
                    <p className="text-xs text-gray-400 mt-1">
                      annotator{globalStats.unique_annotators !== 1 ? 's' : ''}
                    </p>
                  </div>
                </div>

                <div>
                  <p className="text-sm text-gray-400 mb-3">Global label distribution</p>
                  <GlobalDistributionBar distribution={globalStats.label_distribution} />
                </div>
              </section>
            ) : (
              <div className="rounded-xl bg-gray-900 p-6 flex justify-center">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
              </div>
            )}
          </>
        ) : null}
      </main>
    </div>
  )
}
