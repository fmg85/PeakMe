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
