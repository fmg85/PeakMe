import { useState } from 'react'
import { supabase } from '../lib/supabaseClient'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/projects` },
    })
    setLoading(false)
    if (error) {
      setError(error.message)
    } else {
      setSent(true)
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-950 px-4">
      <div className="mb-8 text-center">
        <img src="/PeakMe_logo_orig.png" alt="PeakMe" className="mx-auto h-20 w-auto" />
      </div>

      <div className="w-full max-w-sm rounded-xl bg-gray-900 p-8 shadow-xl">
        {sent ? (
          <div className="text-center">
            <div className="mb-4 text-4xl">📬</div>
            <h2 className="text-lg font-semibold text-white">Check your email</h2>
            <p className="mt-2 text-sm text-gray-400">
              We sent a magic link to <strong className="text-white">{email}</strong>.
              Click it to sign in.
            </p>
          </div>
        ) : (
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-300">
                Email address
              </label>
              <input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@lab.edu"
                className="mt-1 w-full rounded-lg bg-gray-800 px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-brand-purple"
              />
            </div>
            {error && <p className="text-sm text-red-400">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-brand-orange px-4 py-2.5 font-semibold text-white hover:bg-brand-red disabled:opacity-50 transition-colors"
            >
              {loading ? 'Sending…' : 'Send magic link'}
            </button>
          </form>
        )}
      </div>

      <p className="mt-6 text-xs text-gray-600">
        Invite-only — contact your project administrator to get access.
      </p>
    </div>
  )
}
