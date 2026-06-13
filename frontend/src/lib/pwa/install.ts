/**
 * PWA install detection + prompting.
 *
 * - Detects whether the app is already running as an installed PWA (standalone).
 * - On Chromium (Android / desktop) captures `beforeinstallprompt` so we can trigger a
 *   real install dialog from a button.
 * - On Apple Safari (iOS/iPadOS/macOS) there is NO install API, so we expose platform
 *   info and let the UI show "Add to Home Screen / Add to Dock" instructions.
 */
import { useSyncExternalStore } from 'react'

export type Platform = 'ios' | 'android' | 'desktop'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

interface InstallState {
  standalone: boolean
  canPromptProgrammatically: boolean
  platform: Platform
  isSafari: boolean
}

let deferredPrompt: BeforeInstallPromptEvent | null = null
const listeners = new Set<() => void>()

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    // iOS Safari legacy flag
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  )
}

function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'desktop'
  const ua = navigator.userAgent
  // iPadOS 13+ reports as Mac, so also check for touch + Macintosh.
  const iOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  if (iOS) return 'ios'
  if (/Android/.test(ua)) return 'android'
  return 'desktop'
}

function isSafariBrowser(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  return /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(ua)
}

let state: InstallState = {
  standalone: isStandalone(),
  canPromptProgrammatically: false,
  platform: detectPlatform(),
  isSafari: isSafariBrowser(),
}

function setState(patch: Partial<InstallState>) {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

let initialized = false

export function initInstall() {
  if (initialized || typeof window === 'undefined') return
  initialized = true

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferredPrompt = e as BeforeInstallPromptEvent
    setState({ canPromptProgrammatically: true })
  })
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null
    setState({ standalone: true, canPromptProgrammatically: false })
  })
  window.matchMedia?.('(display-mode: standalone)').addEventListener?.('change', (e) => {
    if (e.matches) setState({ standalone: true })
  })
}

/** Trigger the native install prompt (Chromium only). Returns the user's choice. */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  if (!deferredPrompt) return 'unavailable'
  await deferredPrompt.prompt()
  const { outcome } = await deferredPrompt.userChoice
  deferredPrompt = null
  setState({ canPromptProgrammatically: false })
  return outcome
}

// Stable references so useSyncExternalStore doesn't resubscribe on every render.
function subscribeInstall(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
function getInstallSnapshot() {
  return state
}

export function useInstallState(): InstallState {
  return useSyncExternalStore(subscribeInstall, getInstallSnapshot, getInstallSnapshot)
}
