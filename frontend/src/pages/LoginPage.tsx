import { useState, useRef, type KeyboardEvent, type ClipboardEvent } from 'react'
import { supabase } from '../lib/supabaseClient'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [digits, setDigits] = useState(['', '', '', '', '', ''])
  const [loading, setLoading] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRefs = useRef<(HTMLInputElement | null)[]>([])

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    // No emailRedirectTo → Supabase sends a 6-digit code instead of a magic link
    const { error } = await supabase.auth.signInWithOtp({ email })
    setLoading(false)
    if (error) {
      setError(error.message)
    } else {
      setSent(true)
      setTimeout(() => inputRefs.current[0]?.focus(), 50)
    }
  }

  const handleDigitChange = (index: number, value: string) => {
    const digit = value.replace(/\D/g, '').slice(-1)
    const next = [...digits]
    next[index] = digit
    setDigits(next)
    if (digit && index < 5) inputRefs.current[index + 1]?.focus()
    // Auto-submit when all 6 digits filled
    if (digit && next.every((d) => d !== '')) {
      verifyCode(next.join(''))
    }
  }

  const handleDigitKey = (index: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus()
    }
  }

  const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault()
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6)
    if (!pasted) return
    const next = [...digits]
    pasted.split('').forEach((ch, i) => { next[i] = ch })
    setDigits(next)
    inputRefs.current[Math.min(pasted.length, 5)]?.focus()
    if (pasted.length === 6) verifyCode(pasted)
  }

  const verifyCode = async (code: string) => {
    setVerifying(true)
    setError(null)
    const { error } = await supabase.auth.verifyOtp({ email, token: code, type: 'email' })
    setVerifying(false)
    if (error) {
      setError('Invalid or expired code — please try again.')
      setDigits(['', '', '', '', '', ''])
      setTimeout(() => inputRefs.current[0]?.focus(), 50)
    }
    // On success, App.tsx's onAuthStateChange fires and redirects to /projects
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-950 px-4">
      <div className="mb-8 text-center">
        <img src="/PeakMe_logo_orig.png" alt="PeakMe" className="mx-auto h-28 w-auto rounded-xl" />
      </div>

      <div className="w-full max-w-sm rounded-xl bg-gray-900 p-8 shadow-xl">
        {!sent ? (
          <form onSubmit={handleSend} className="space-y-4">
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
              {loading ? 'Sending…' : 'Send code'}
            </button>

            <div className="relative flex items-center gap-3">
              <div className="flex-1 border-t border-gray-700" />
              <span className="text-xs text-gray-500">or</span>
              <div className="flex-1 border-t border-gray-700" />
            </div>

            <button
              type="button"
              onClick={() => supabase.auth.signInWithOAuth({
                provider: 'google',
                options: { redirectTo: `${window.location.origin}/projects` },
              })}
              className="w-full flex items-center justify-center gap-3 rounded-lg bg-white px-4 py-2.5 font-semibold text-gray-800 hover:bg-gray-100 transition-colors"
            >
              <GoogleIcon />
              Continue with Google
            </button>
          </form>
        ) : (
          <div className="space-y-5">
            <div className="text-center">
              <div className="mb-3 text-4xl">📬</div>
              <h2 className="text-lg font-semibold text-white">Enter your code</h2>
              <p className="mt-1 text-sm text-gray-400">
                We sent a 6-digit code to <strong className="text-white">{email}</strong>
              </p>
            </div>

            {/* 6-digit OTP input */}
            <div className="flex justify-center gap-2">
              {digits.map((d, i) => (
                <input
                  key={i}
                  ref={(el) => { inputRefs.current[i] = el }}
                  type="text"
                  inputMode="numeric"
                  maxLength={1}
                  value={d}
                  onChange={(e) => handleDigitChange(i, e.target.value)}
                  onKeyDown={(e) => handleDigitKey(i, e)}
                  onPaste={handlePaste}
                  className="h-12 w-10 rounded-lg bg-gray-800 text-center text-xl font-bold text-white focus:outline-none focus:ring-2 focus:ring-brand-purple caret-transparent"
                />
              ))}
            </div>

            {error && <p className="text-sm text-red-400 text-center">{error}</p>}

            <button
              onClick={() => verifyCode(digits.join(''))}
              disabled={digits.some((d) => !d) || verifying}
              className="w-full rounded-lg bg-brand-orange px-4 py-2.5 font-semibold text-white hover:bg-brand-red disabled:opacity-50 transition-colors"
            >
              {verifying ? 'Verifying…' : 'Sign in'}
            </button>

            <button
              onClick={() => { setSent(false); setDigits(['', '', '', '', '', '']); setError(null) }}
              className="w-full text-sm text-gray-500 hover:text-gray-300 transition-colors"
            >
              ← Use a different email
            </button>
          </div>
        )}
      </div>

      <p className="mt-6 text-xs text-gray-600">
        Invite-only — contact your project administrator to get access.
      </p>
    </div>
  )
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
      <g fill="none" fillRule="evenodd">
        <path d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
        <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
        <path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
        <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
      </g>
    </svg>
  )
}
