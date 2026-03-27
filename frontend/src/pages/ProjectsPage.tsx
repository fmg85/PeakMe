import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import apiClient from '../lib/apiClient'
import { supabase } from '../lib/supabaseClient'
import type { Project } from '../lib/types'

export default function ProjectsPage() {
  const queryClient = useQueryClient()
  const [showNew, setShowNew] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  const { data: projects, isLoading } = useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: () => apiClient.get('/api/projects').then((r) => r.data),
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

  const handleSignOut = () => supabase.auth.signOut()

  return (
    <div className="min-h-screen bg-gray-950">
      <header className="border-b border-gray-800 bg-gray-900 px-6 py-4 flex items-center justify-between">
        <h1 className="text-xl font-bold text-white">PeakMe</h1>
        <button onClick={handleSignOut} className="text-sm text-gray-400 hover:text-white transition-colors">
          Sign out
        </button>
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
        ) : projects?.length === 0 ? (
          <div className="rounded-xl bg-gray-900 p-10 text-center text-gray-500">
            No projects yet. Create one to get started.
          </div>
        ) : (
          <div className="space-y-3">
            {projects?.map((project) => (
              <Link
                key={project.id}
                to={`/projects/${project.id}`}
                className="block rounded-xl bg-gray-900 p-5 hover:bg-gray-800 transition-colors"
              >
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
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
