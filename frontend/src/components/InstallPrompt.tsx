import { useState } from 'react'
import { promptInstall, useInstallState } from '../lib/pwa/install'

const DISMISS_KEY = 'peakme-install-dismissed'

/**
 * Dismissible "install for offline" banner. Hidden when already running as an installed
 * PWA. On Chromium it triggers the real install prompt; on Apple Safari it shows the
 * manual "Add to Home Screen / Add to Dock" steps (no install API exists there).
 */
export default function InstallPrompt() {
  const { standalone, canPromptProgrammatically, platform, isSafari } = useInstallState()
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === '1')
  const [showHelp, setShowHelp] = useState(false)

  const appleManual = (platform === 'ios' || isSafari) && !canPromptProgrammatically
  const shouldShow = !standalone && !dismissed && (canPromptProgrammatically || appleManual)
  if (!shouldShow) return null

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, '1')
    setDismissed(true)
  }

  const onInstall = async () => {
    const outcome = await promptInstall()
    if (outcome === 'accepted') dismiss()
  }

  const macSafari = isSafari && platform === 'desktop'

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 border-t border-gray-800 bg-gray-900/95 px-4 py-3 backdrop-blur">
      <div className="mx-auto flex max-w-md items-start gap-3">
        <div className="flex-1">
          <p className="text-sm font-medium text-white">Install PeakMe for offline annotating</p>
          {canPromptProgrammatically ? (
            <p className="mt-0.5 text-xs text-gray-400">Add it to your device to annotate without a connection.</p>
          ) : (
            <>
              <button
                onClick={() => setShowHelp((s) => !s)}
                className="mt-0.5 text-xs text-brand-orange hover:underline"
              >
                {showHelp ? 'Hide steps' : 'How to add it →'}
              </button>
              {showHelp && (
                <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs text-gray-300">
                  <li>
                    Tap the <span className="font-semibold">Share</span>
                    <span aria-hidden> ⎙</span> button{macSafari ? ' (or the File menu)' : ' in the toolbar'}
                  </li>
                  <li>
                    Choose <span className="font-semibold">{macSafari ? '“Add to Dock”' : '“Add to Home Screen”'}</span>
                  </li>
                  <li>Open PeakMe from the new icon to use it offline</li>
                </ol>
              )}
            </>
          )}
        </div>
        {canPromptProgrammatically && (
          <button
            onClick={onInstall}
            className="rounded-lg bg-brand-orange px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-red"
          >
            Install
          </button>
        )}
        <button onClick={dismiss} aria-label="Dismiss" className="text-gray-500 hover:text-gray-300">
          ✕
        </button>
      </div>
    </div>
  )
}
