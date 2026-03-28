import { useEffect, useState } from 'react'

interface ChangelogSection {
  title: string
  items: Array<{ type: string; description: string }>
}

const TYPE_STYLE: Record<string, string> = {
  feat:     'bg-green-900/60 text-green-300',
  fix:      'bg-orange-900/60 text-orange-300',
  perf:     'bg-blue-900/60 text-blue-300',
  breaking: 'bg-red-900/60 text-red-300',
  docs:     'bg-gray-800 text-gray-400',
  chore:    'bg-gray-800 text-gray-500',
  refactor: 'bg-purple-900/60 text-purple-300',
}

function parseChangelog(text: string): ChangelogSection[] {
  return text
    .split(/\n## /)
    .slice(1) // drop preamble before first ##
    .map((block) => {
      const lines = block.split('\n')
      const title = lines[0].trim()
      const items = lines
        .filter((l) => l.startsWith('- '))
        .map((l) => {
          const m = l.slice(2).match(/^(\w+):\s+(.+)$/)
          return m
            ? { type: m[1], description: m[2] }
            : { type: '', description: l.slice(2) }
        })
      return { title, items }
    })
    .filter((s) => s.items.length > 0)
}

export default function ChangelogModal({ onClose }: { onClose: () => void }) {
  const [sections, setSections] = useState<ChangelogSection[]>([])
  const [error, setError] = useState(false)

  useEffect(() => {
    fetch('/CHANGELOG.md')
      .then((r) => r.text())
      .then((text) => setSections(parseChangelog(text)))
      .catch(() => setError(true))
  }, [])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-2xl bg-gray-900 border border-gray-700 shadow-2xl overflow-hidden flex flex-col max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <h2 className="text-base font-semibold text-white">What's new</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors text-lg leading-none">✕</button>
        </div>

        <div className="overflow-y-auto px-6 py-4 space-y-6">
          {error && <p className="text-sm text-gray-500">Could not load changelog.</p>}
          {sections.map((section) => (
            <div key={section.title}>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                {section.title === 'Unreleased' ? '🔜 Coming / unreleased' : section.title}
              </p>
              <ul className="space-y-1.5">
                {section.items.map((item, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    {item.type && (
                      <span className={`mt-0.5 rounded px-1.5 py-0.5 text-xs font-mono font-medium flex-shrink-0 ${TYPE_STYLE[item.type] ?? 'bg-gray-800 text-gray-400'}`}>
                        {item.type}
                      </span>
                    )}
                    <span className="text-gray-300">{item.description}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
