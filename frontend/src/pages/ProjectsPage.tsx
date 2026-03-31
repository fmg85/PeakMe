import { useState, useRef, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import apiClient from '../lib/apiClient'
import { supabase } from '../lib/supabaseClient'
import type { Project, User } from '../lib/types'
import ChangelogModal from '../components/ChangelogModal'

export default function ProjectsPage() {
  const queryClient = useQueryClient()
  const [showNew, setShowNew] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  // Profile state
  const [showProfile, setShowProfile] = useState(false)
  const [showChangelog, setShowChangelog] = useState(false)
  const [confirmDeleteProjectId, setConfirmDeleteProjectId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const profileRef = useRef<HTMLDivElement>(null)

  const { data: projects, isLoading, isError, error } = useQuery<Project[], Error>({
    queryKey: ['projects'],
    queryFn: () => apiClient.get('/api/projects').then((r) => r.data),
  })

  const { data: me } = useQuery<User>({
    queryKey: ['me'],
    queryFn: () => apiClient.get('/api/auth/me').then((r) => r.data),
  })

  const updateProfile = useMutation({
    mutationFn: (display_name: string) =>
      apiClient.post('/api/auth/sync', { display_name }).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['me'] })
      setShowProfile(false)
    },
  })

  const deleteProject = useMutation({
    mutationFn: (projectId: string) => apiClient.delete(`/api/projects/${projectId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  })

  const createProject = useMutation({
    mutationFn: (body: { name: string; description?: string }) =>
      apiClient.post('/api/projects', body).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      setShowNew(false)
      setName('')
      setDescription('')
    },
  })

  // Close profile dropdown when clicking outside
  useEffect(() => {
    if (!showProfile) return
    const handleClick = (e: MouseEvent) => {
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) {
        setShowProfile(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showProfile])

  const handleSignOut = () => supabase.auth.signOut()

  const openProfile = () => {
    setEditingName(me?.display_name ?? '')
    setShowProfile(true)
  }

  return (
    <div className="min-h-screen bg-gray-950">
      {showChangelog && <ChangelogModal onClose={() => setShowChangelog(false)} />}
      <header className="border-b border-gray-800 bg-gray-900 px-6 py-4 flex items-center justify-between">
        <img src="/PeakMe_logo_orig.png" alt="PeakMe" className="h-12 w-auto" />
        <div className="flex items-center gap-4">
          <Link
            to="/instructions"
            className="text-sm text-gray-400 hover:text-white transition-colors"
          >
            Instructions
          </Link>

          {/* Profile dropdown */}
          <div className="relative" ref={profileRef}>
            <button
              onClick={openProfile}
              className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-purple text-xs font-semibold text-white">
                {me?.display_name?.[0]?.toUpperCase() ?? '?'}
              </span>
              <span className="hidden sm:inline">{me?.display_name ?? '…'}</span>
            </button>

            {showProfile && (
              <div className="absolute right-0 top-full mt-2 w-72 rounded-xl border border-gray-700 bg-gray-900 p-4 shadow-2xl z-50 space-y-3">
                <p className="text-xs text-gray-500">{me?.email}</p>
                <div className="space-y-2">
                  <label className="text-xs font-medium text-gray-400">Display name</label>
                  <input
                    value={editingName}
                    onChange={(e) => setEditingName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && editingName.trim()) {
                        updateProfile.mutate(editingName.trim())
                      }
                      if (e.key === 'Escape') setShowProfile(false)
                    }}
                    placeholder="Your name"
                    className="w-full rounded-lg bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-brand-purple"
                    autoFocus
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => { if (editingName.trim()) updateProfile.mutate(editingName.trim()) }}
                    disabled={!editingName.trim() || updateProfile.isPending}
                    className="flex-1 rounded-lg bg-brand-orange px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-red disabled:opacity-50 transition-colors"
                  >
                    Save
                  </button>
                  <button
                    onClick={handleSignOut}
                    className="rounded-lg bg-gray-800 px-3 py-1.5 text-sm text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
                  >
                    Sign out
                  </button>
                </div>
                <button
                  onClick={() => { setShowProfile(false); setShowChangelog(true) }}
                  className="w-full rounded-lg bg-gray-800/50 px-3 py-1.5 text-sm text-gray-400 hover:text-white hover:bg-gray-800 transition-colors text-left"
                >
                  📋 What's new
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-10">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-2xl font-semibold text-white">Projects</h2>
          <button
            onClick={() => setShowNew(true)}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 transition-colors"
          >
            + New project
          </button>
        </div>

        {showNew && (
          <div className="mb-6 rounded-xl bg-gray-900 p-6 space-y-4">
            <h3 className="font-semibold text-white">New project</h3>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Project name"
              className="w-full rounded-lg bg-gray-800 px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Description (optional)"
              rows={2}
              className="w-full rounded-lg bg-gray-800 px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
            />
            <div className="flex gap-3">
              <button
                onClick={() => createProject.mutate({ name, description: description || undefined })}
                disabled={!name.trim() || createProject.isPending}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
              >
                Create
              </button>
              <button onClick={() => setShowNew(false)} className="text-sm text-gray-400 hover:text-white">
                Cancel
              </button>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-20 animate-pulse rounded-xl bg-gray-900" />
            ))}
          </div>
        ) : isError ? (
          <div className="rounded-xl bg-gray-900 p-10 text-center space-y-2">
            <p className="text-red-400 font-medium">Failed to load projects.</p>
            <p className="text-xs text-gray-500">
              {(error as any)?.response?.status
                ? `HTTP ${(error as any).response.status}: ${(error as any).response.data?.detail ?? 'unknown error'}`
                : error?.message ?? 'Network error — check your connection.'}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="mt-2 rounded-lg bg-gray-700 px-4 py-1.5 text-xs text-gray-300 hover:bg-gray-600 transition-colors"
            >
              Retry
            </button>
          </div>
        ) : projects?.length === 0 ? (
          <div className="rounded-xl bg-gray-900 p-10 text-center text-gray-500">
            No projects yet. Create one to get started.
          </div>
        ) : (
          <div className="space-y-3">
            {projects?.map((project) => (
              <div key={project.id} className="group relative rounded-xl bg-gray-900 hover:bg-gray-800 transition-colors">
                <Link to={`/projects/${project.id}`} className="block p-5 pr-8">
                  <div className="flex items-start justify-between">
                    <div>
                      <h3 className="font-semibold text-white">{project.name}</h3>
                      {project.description && (
                        <p className="mt-1 text-sm text-gray-400">{project.description}</p>
                      )}
                    </div>
                    <div className="flex gap-2 flex-wrap justify-end ml-4">
                      {project.label_options.slice(0, 5).map((l) => (
                        <span
                          key={l.id}
                          className="rounded-full px-2 py-0.5 text-xs font-medium text-white"
                          style={{ backgroundColor: l.color || '#6366f1' }}
                        >
                          {l.name}
                        </span>
                      ))}
                      {project.label_options.length > 5 && (
                        <span className="text-xs text-gray-500">+{project.label_options.length - 5}</span>
                      )}
                    </div>
                  </div>
                </Link>
                {/* Delete control — sits outside the Link */}
                <div className="absolute top-3 right-3" onClick={(e) => e.stopPropagation()}>
                  {confirmDeleteProjectId === project.id ? (
                    <div className="flex items-center gap-1.5 text-xs">
                      <span className="text-gray-400">Delete project?</span>
                      <button
                        onClick={() => { deleteProject.mutate(project.id); setConfirmDeleteProjectId(null) }}
                        className="rounded px-2 py-0.5 bg-red-600 text-white hover:bg-red-500 transition-colors"
                      >Yes</button>
                      <button
                        onClick={() => setConfirmDeleteProjectId(null)}
                        className="rounded px-2 py-0.5 bg-gray-700 text-gray-300 hover:bg-gray-600 transition-colors"
                      >No</button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmDeleteProjectId(project.id)}
                      className="text-gray-700 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100 text-sm"
                      title="Delete project"
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
