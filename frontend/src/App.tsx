import { useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { supabase } from './lib/supabaseClient'
import type { User as SupabaseUser } from '@supabase/supabase-js'
import LoginPage from './pages/LoginPage'
import ProjectsPage from './pages/ProjectsPage'
import ProjectDetailPage from './pages/ProjectDetailPage'
import AnnotatePage from './pages/AnnotatePage'
import StatsPage from './pages/StatsPage'
import InstructionsPage from './pages/InstructionsPage'

function App() {
  const [user, setUser] = useState<SupabaseUser | null | undefined>(undefined)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
    })
    return () => subscription.unsubscribe()
  }, [])

  // Still loading auth state
  if (user === undefined) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
      </div>
    )
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/login"
          element={user ? <Navigate to="/projects" replace /> : <LoginPage />}
        />
        <Route
          path="/projects"
          element={user ? <ProjectsPage /> : <Navigate to="/login" replace />}
        />
        <Route
          path="/projects/:projectId"
          element={user ? <ProjectDetailPage /> : <Navigate to="/login" replace />}
        />
        <Route
          path="/projects/:projectId/annotate"
          element={user ? <AnnotatePage /> : <Navigate to="/login" replace />}
        />
        <Route
          path="/projects/:projectId/stats"
          element={user ? <StatsPage /> : <Navigate to="/login" replace />}
        />
        <Route
          path="/instructions"
          element={user ? <InstructionsPage /> : <Navigate to="/login" replace />}
        />
        <Route path="*" element={<Navigate to={user ? '/projects' : '/login'} replace />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
