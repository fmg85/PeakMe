import { Link } from 'react-router-dom'
import apiClient from '../lib/apiClient'

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="my-3 overflow-x-auto rounded-lg bg-gray-900 p-4 text-xs text-green-300 font-mono leading-relaxed">
      {children}
    </pre>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-white border-b border-gray-800 pb-2">{title}</h2>
      {children}
    </section>
  )
}

function OptionTable() {
  const rows = [
    ['--input', '(required)', 'Path to .imzML or .RData file'],
    ['--output', './peakme_export', 'Output directory'],
    ['--width', '400', 'Image width in pixels'],
    ['--height', '400', 'Image height in pixels'],
    ['--colormap', 'viridis', 'Color scale: viridis, magma, plasma, inferno, cividis'],
    ['--normalize', 'rms', 'Normalization: tic, rms, none'],
    ['--zip', 'off', 'Automatically zip the output folder'],
    ['--object-name', 'auto', 'Object name in .RData file'],
  ]
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-800">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-800 bg-gray-900">
            <th className="px-4 py-2 text-left text-gray-400 font-medium">Option</th>
            <th className="px-4 py-2 text-left text-gray-400 font-medium">Default</th>
            <th className="px-4 py-2 text-left text-gray-400 font-medium">Description</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([opt, def, desc]) => (
            <tr key={opt} className="border-b border-gray-800/50 hover:bg-gray-900/50">
              <td className="px-4 py-2 font-mono text-xs text-green-300">{opt}</td>
              <td className="px-4 py-2 font-mono text-xs text-gray-400">{def}</td>
              <td className="px-4 py-2 text-gray-300">{desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function InstructionsPage() {
  const handleDownloadScript = async () => {
    try {
      const response = await apiClient.get('/api/instructions/r-script', { responseType: 'blob' })
      const url = URL.createObjectURL(new Blob([response.data], { type: 'text/plain' }))
      const a = document.createElement('a')
      a.href = url
      a.download = 'export_cardinal_pngs.R'
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      alert('Could not download the R script — please try again.')
    }
  }

  return (
    <div className="min-h-screen bg-gray-950">
      <header className="border-b border-gray-800 bg-gray-900 px-6 py-4 flex items-center gap-4">
        <Link to="/projects" className="text-gray-400 hover:text-white transition-colors">
          ← Projects
        </Link>
        <h1 className="text-xl font-bold text-white">Instructions</h1>
        <div className="ml-auto">
          <button
            onClick={handleDownloadScript}
            className="rounded-lg bg-brand-orange px-4 py-2 text-sm font-medium text-white hover:bg-brand-red transition-colors"
          >
            ↓ Download R Script
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-10 space-y-10">

        {/* Overview */}
        <div className="rounded-xl bg-gray-900 p-6 space-y-3">
          <h2 className="text-lg font-semibold text-white">Overview</h2>
          <p className="text-gray-300">
            PeakMe does not process raw mass spectrometry files server-side. Instead, you render
            ion images locally using Cardinal (R), then upload a ZIP of PNGs to PeakMe. This keeps
            the server lightweight and gives you full control over rendering parameters.
          </p>
          <div className="flex flex-col gap-1.5 text-sm text-gray-400">
            {['1. Install R dependencies', '2. Run export_cardinal_pngs.R on your data', '3. Zip the output folder', '4. Upload the ZIP to PeakMe and create a dataset'].map((step) => (
              <div key={step} className="flex items-center gap-2">
                <span className="text-brand-orange">→</span>
                <span>{step}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Step 1 */}
        <Section title="Step 1 — Install R Dependencies">
          <p className="text-sm text-gray-400">In R or RStudio:</p>
          <CodeBlock>{`if (!requireNamespace("BiocManager", quietly = TRUE))
  install.packages("BiocManager")

BiocManager::install("Cardinal")
install.packages(c("viridis", "optparse"))`}</CodeBlock>
        </Section>

        {/* Step 2 */}
        <Section title="Step 2 — Run the Export Script">
          <p className="text-sm text-gray-400">
            Download the R script using the button above, then run it from the command line.
          </p>

          <h3 className="text-sm font-medium text-gray-300 mt-4">From an imzML file:</h3>
          <CodeBlock>{`Rscript export_cardinal_pngs.R \\
  --input /path/to/your/data.imzML \\
  --output ./peakme_export \\
  --colormap viridis \\
  --normalize rms \\
  --zip`}</CodeBlock>

          <h3 className="text-sm font-medium text-gray-300 mt-4">From a saved .RData / .rda file:</h3>
          <CodeBlock>{`# In R: save your experiment first
save(msi_experiment, file = "my_experiment.RData")

# Then export
Rscript export_cardinal_pngs.R \\
  --input my_experiment.RData \\
  --output ./peakme_export \\
  --zip`}</CodeBlock>
          <p className="text-xs text-gray-500">
            If the .RData contains multiple objects, add{' '}
            <code className="rounded bg-gray-800 px-1 text-green-300">--object-name msi_experiment</code>{' '}
            to specify which one.
          </p>

          <h3 className="text-sm font-medium text-gray-300 mt-4">All options:</h3>
          <OptionTable />
        </Section>

        {/* Step 3 */}
        <Section title="Step 3 — Output Format">
          <p className="text-sm text-gray-400">The script produces:</p>
          <CodeBlock>{`peakme_export/
  metadata.csv          ← required by PeakMe
  798.5432.png          ← one PNG per m/z feature
  799.1201.png
  ...`}</CodeBlock>
          <p className="text-sm text-gray-400">
            <strong className="text-white">metadata.csv</strong> maps each PNG filename to its m/z value:
          </p>
          <CodeBlock>{`filename,mz_value
798.5432.png,798.5432
799.1201.png,799.1201`}</CodeBlock>
          <p className="text-xs text-gray-500">
            You can create or edit this file manually if you have PNGs from a different source.
          </p>
        </Section>

        {/* Step 4 */}
        <Section title="Step 4 — Upload to PeakMe">
          <ol className="space-y-2 text-sm text-gray-300 list-decimal list-inside">
            <li>If you used <code className="rounded bg-gray-800 px-1 text-green-300">--zip</code>, a <code className="rounded bg-gray-800 px-1 text-green-300">peakme_export.zip</code> was created automatically.</li>
            <li>
              If not, zip manually:
              <CodeBlock>{'zip -r peakme_export.zip peakme_export/'}</CodeBlock>
            </li>
            <li>Go to your PeakMe project → <strong className="text-white">Upload dataset (ZIP)</strong> → upload the ZIP.</li>
          </ol>
        </Section>

        {/* Tips */}
        <Section title="Tips">
          <ul className="space-y-3 text-sm text-gray-300">
            <li className="flex gap-2">
              <span className="text-brand-orange flex-shrink-0">•</span>
              <span><strong className="text-white">Large datasets (&gt;10,000 ions):</strong> The script prints progress every 100 ions. A 10,000-ion dataset typically takes 5–15 minutes.</span>
            </li>
            <li className="flex gap-2">
              <span className="text-brand-orange flex-shrink-0">•</span>
              <span><strong className="text-white">Image resolution:</strong> 400×400 px is recommended. Larger images (e.g. 800×800) improve zoom quality but increase upload time.</span>
            </li>
            <li className="flex gap-2">
              <span className="text-brand-orange flex-shrink-0">•</span>
              <span><strong className="text-white">Colormap:</strong> <code className="rounded bg-gray-800 px-1 text-green-300">viridis</code> is perceptually uniform and colorblind-friendly. <code className="rounded bg-gray-800 px-1 text-green-300">magma</code> highlights sparse signals. Use the same colormap within a project for consistent comparisons.</span>
            </li>
            <li className="flex gap-2">
              <span className="text-brand-orange flex-shrink-0">•</span>
              <span><strong className="text-white">Normalization:</strong> TIC is standard for cross-tissue comparison. Use <code className="rounded bg-gray-800 px-1 text-green-300">none</code> if you've already normalized in Cardinal.</span>
            </li>
            <li className="flex gap-2">
              <span className="text-brand-orange flex-shrink-0">•</span>
              <span>
                <strong className="text-white">Subsetting m/z range:</strong> Pre-filter in R before exporting:
                <CodeBlock>{'msi_subset <- msi[mz(msi) > 700 & mz(msi) < 900, ]\nsave(msi_subset, file = "subset_700_900.RData")'}</CodeBlock>
              </span>
            </li>
          </ul>
        </Section>

      </main>
    </div>
  )
}
