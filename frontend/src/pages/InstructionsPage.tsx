import { Link } from 'react-router-dom'

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
    ['--file', '(required)', 'Path to .imzML or .RData file'],
    ['--output', './peakme_export', 'Output directory'],
    ['--width', '400', 'Image width in pixels'],
    ['--height', '400', 'Image height in pixels'],
    ['--colormap', 'viridis', 'Color scale: viridis, magma, plasma, inferno, cividis'],
    ['--normalize', 'rms', 'Normalization: tic, rms, none'],
    ['--zip', 'off', 'Automatically zip the output folder'],
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

function ImportOptionTable() {
  const rows = [
    ['msi_object', '"MSE_process"', 'Name of your MSImagingExperiment variable in the R session'],
    ['csv_file', '"peakme_annotations.csv"', 'Path to the CSV exported from PeakMe'],
    ['multi_annotator', '"last"', 'When multiple annotators labelled the same ion: "first" or "last" (by timestamp)'],
    ['labels_to_remove', 'c("matrix", "noise")', 'Labels to strip out when creating MSE_clean'],
    ['unannotated', '"keep"', 'What to do with ions not in the CSV: "keep" (label = NA) or "remove"'],
  ]
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-800">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-800 bg-gray-900">
            <th className="px-4 py-2 text-left text-gray-400 font-medium">Setting</th>
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
  const download = (filename: string) => {
    const a = document.createElement('a')
    a.href = `/${filename}`
    a.download = filename
    a.click()
  }

  return (
    <div className="min-h-screen bg-gray-950">
      <header className="border-b border-gray-800 bg-gray-900 px-6 py-4 flex items-center gap-4">
        <Link to="/projects" className="text-gray-400 hover:text-white transition-colors">
          ← Projects
        </Link>
        <h1 className="text-xl font-bold text-white">Instructions</h1>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => download('export_cardinal_pngs.R')}
            className="rounded-lg bg-brand-orange px-4 py-2 text-sm font-medium text-white hover:bg-brand-red transition-colors"
          >
            ↓ Export script
          </button>
          <button
            onClick={() => download('peakme_import.R')}
            className="rounded-lg bg-brand-purple px-4 py-2 text-sm font-medium text-white hover:opacity-90 transition-opacity"
          >
            ↓ Import script
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-10 space-y-10">

        {/* Overview */}
        <div className="rounded-xl bg-gray-900 p-6 space-y-4">
          <h2 className="text-lg font-semibold text-white">Overview</h2>
          <p className="text-gray-300">
            PeakMe does not process raw mass spectrometry files server-side. Instead, you render
            ion images locally using Cardinal (R), upload a ZIP of PNGs to PeakMe for annotation,
            then import the labels back into R for downstream analysis.
          </p>
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-lg border border-brand-orange/30 bg-brand-orange/5 p-4 space-y-2">
              <p className="text-sm font-semibold text-brand-orange">Part 1 — Export (R → PeakMe)</p>
              <div className="flex flex-col gap-1 text-sm text-gray-400">
                {['1. Install R dependencies', '2. Run export_cardinal_pngs.R', '3. Zip the output folder', '4. Upload the ZIP to PeakMe'].map((step) => (
                  <div key={step} className="flex items-center gap-2">
                    <span className="text-brand-orange">→</span>
                    <span>{step}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-lg border border-brand-purple/30 bg-brand-purple/5 p-4 space-y-2">
              <p className="text-sm font-semibold text-brand-purple">Part 2 — Import (PeakMe → R)</p>
              <div className="flex flex-col gap-1 text-sm text-gray-400">
                {['5. Annotate in PeakMe', '6. Export annotations CSV', '7. Run peakme_import.R', '8. Use MSE_process + MSE_clean'].map((step) => (
                  <div key={step} className="flex items-center gap-2">
                    <span className="text-brand-purple">→</span>
                    <span>{step}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* ── PART 1 ── */}
        <div className="rounded-lg border border-brand-orange/20 px-1">
          <div className="px-4 py-3">
            <span className="text-xs font-semibold uppercase tracking-widest text-brand-orange">Part 1 — Export (Cardinal → PeakMe)</span>
          </div>
        </div>

        {/* Step 1 */}
        <Section title="Step 1 — Install R Dependencies">
          <p className="text-sm text-gray-400">In R or RStudio:</p>
          <CodeBlock>{`if (!requireNamespace("BiocManager", quietly = TRUE))
  install.packages("BiocManager")

BiocManager::install("Cardinal")
install.packages(c("viridis", "optparse", "png"))`}</CodeBlock>
        </Section>

        {/* Step 2 */}
        <Section title="Step 2 — Run the Export Script">
          <p className="text-sm text-gray-400">
            The script works with any <code className="rounded bg-gray-800 px-1 text-green-300">MSImagingExperiment</code> — raw read-in, peak-picked, aligned, filtered, whatever state your data is in.
          </p>

          {/* RStudio block */}
          <div className="mt-4 rounded-lg border border-brand-purple/40 bg-brand-purple/10 p-4 space-y-2">
            <p className="text-sm font-semibold text-brand-purple">RStudio (Windows or Mac) — recommended</p>
            <ol className="text-sm text-gray-300 space-y-1 list-decimal list-inside">
              <li>Open <code className="rounded bg-gray-800 px-1 text-green-300">export_cardinal_pngs.R</code> in RStudio</li>
              <li>Edit the config block near the top — two options:</li>
            </ol>
            <p className="text-xs text-gray-400 pl-4">
              <strong className="text-gray-200">Option A</strong> — object already in your session (e.g. after loading or processing in Cardinal):
            </p>
            <CodeBlock>{`msi_object = "MSE_process",  # name of your MSImagingExperiment variable
                             # run ls() in the Console to see what's loaded
msi_file   = NULL,`}</CodeBlock>
            <p className="text-xs text-gray-400 pl-4">
              <strong className="text-gray-200">Option B</strong> — load from a file (.imzML or .RData):
            </p>
            <CodeBlock>{`msi_object = NULL,
msi_file   = "C:/Users/YourName/data/sample.imzML",
             # or "C:/Users/YourName/experiment.RData"`}</CodeBlock>
            <p className="text-xs text-gray-400 pl-4">
              If your .RData has multiple objects, the script auto-detects all <code className="rounded bg-gray-800 px-1 text-green-300">MSImagingExperiment</code>s and tells you their names.
            </p>
            <ol className="text-sm text-gray-300 space-y-1 list-decimal list-inside" start={3}>
              <li>Also set <code className="rounded bg-gray-800 px-1 text-green-300">output</code> to where you want the PNGs saved</li>
              <li>Press <kbd className="rounded bg-gray-700 px-1.5 py-0.5 text-xs">Ctrl+Shift+S</kbd> (Windows) or <kbd className="rounded bg-gray-700 px-1.5 py-0.5 text-xs">⌘⇧S</kbd> (Mac) to Source</li>
              <li>Watch the Console — done when you see <code className="rounded bg-gray-800 px-1 text-green-300">Done. Upload … to PeakMe.</code></li>
            </ol>
          </div>

          <h3 className="text-sm font-medium text-gray-300 mt-5">Terminal / command line</h3>
          <CodeBlock>{`Rscript export_cardinal_pngs.R \\
  --file /path/to/data.imzML \\
  --output ./peakme_export \\
  --zip

# or from an RData file:
Rscript export_cardinal_pngs.R \\
  --file /path/to/experiment.RData \\
  --output ./peakme_export \\
  --zip`}</CodeBlock>

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

        {/* ── PART 2 ── */}
        <div className="rounded-lg border border-brand-purple/20 px-1 mt-8">
          <div className="px-4 py-3">
            <span className="text-xs font-semibold uppercase tracking-widest text-brand-purple">Part 2 — Import (PeakMe → R)</span>
          </div>
        </div>

        {/* Step 5 */}
        <Section title="Step 5 — Export Annotations from PeakMe">
          <p className="text-sm text-gray-400">
            Once annotation is complete, download the CSV from PeakMe:
          </p>
          <ol className="space-y-2 text-sm text-gray-300 list-decimal list-inside">
            <li>Go to your project page in PeakMe</li>
            <li>Click <strong className="text-white">Export CSV</strong> next to the dataset (or project-wide)</li>
            <li>Save the file — e.g. <code className="rounded bg-gray-800 px-1 text-green-300">peakme_annotations.csv</code></li>
          </ol>
          <p className="text-sm text-gray-400 mt-2">
            The CSV contains one row per annotated ion with columns: <code className="rounded bg-gray-800 px-1 text-green-300">mz_value</code>, <code className="rounded bg-gray-800 px-1 text-green-300">label_name</code>, <code className="rounded bg-gray-800 px-1 text-green-300">starred</code>, <code className="rounded bg-gray-800 px-1 text-green-300">confidence</code>, <code className="rounded bg-gray-800 px-1 text-green-300">annotator</code>, and timestamps.
          </p>
        </Section>

        {/* Step 6 */}
        <Section title="Step 6 — Run the Import Script">
          <p className="text-sm text-gray-400">
            <code className="rounded bg-gray-800 px-1 text-green-300">peakme_import.R</code> reads the CSV, matches each annotation back to the correct m/z feature in your <code className="rounded bg-gray-800 px-1 text-green-300">MSImagingExperiment</code>, and creates a filtered object ready for downstream analysis.
          </p>

          <div className="mt-4 rounded-lg border border-brand-purple/40 bg-brand-purple/10 p-4 space-y-2">
            <p className="text-sm font-semibold text-brand-purple">RStudio — recommended</p>
            <ol className="text-sm text-gray-300 space-y-1 list-decimal list-inside">
              <li>Make sure your <code className="rounded bg-gray-800 px-1 text-green-300">MSImagingExperiment</code> is loaded in the session (same object you exported from)</li>
              <li>Open <code className="rounded bg-gray-800 px-1 text-green-300">peakme_import.R</code> and edit the config block:</li>
            </ol>
            <CodeBlock>{`msi_object       = "MSE_process",         # name of your MSE variable
csv_file         = "peakme_annotations.csv", # path to the downloaded CSV
labels_to_remove = c("matrix", "noise"),     # labels to strip for MSE_clean
unannotated      = "keep"                    # "keep" or "remove" unannotated ions`}</CodeBlock>
            <ol className="text-sm text-gray-300 space-y-1 list-decimal list-inside" start={3}>
              <li>Press <kbd className="rounded bg-gray-700 px-1.5 py-0.5 text-xs">Ctrl+Shift+S</kbd> (Windows) or <kbd className="rounded bg-gray-700 px-1.5 py-0.5 text-xs">⌘⇧S</kbd> (Mac) to Source</li>
              <li>The script prints a coverage summary and label breakdown in the Console</li>
            </ol>
          </div>

          <h3 className="text-sm font-medium text-gray-300 mt-5">What the script produces</h3>
          <p className="text-sm text-gray-400">It adds four columns to <code className="rounded bg-gray-800 px-1 text-green-300">fData()</code> of your existing MSE object:</p>
          <CodeBlock>{`fData(MSE_process)$peakme_label      # "liver", "kidney", NA (unannotated), …
fData(MSE_process)$peakme_starred    # TRUE / FALSE / NA
fData(MSE_process)$peakme_confidence # 1 (low) · 2 (medium) · 3 (high) · NA
fData(MSE_process)$peakme_annotator  # annotator display name · NA`}</CodeBlock>
          <p className="text-sm text-gray-400">It also creates <code className="rounded bg-gray-800 px-1 text-green-300">MSE_clean</code> in your session — the same experiment with <code className="rounded bg-gray-800 px-1 text-green-300">labels_to_remove</code> features filtered out:</p>
          <CodeBlock>{`# Example: 5,072 total → 655 noise/matrix removed → 4,417 features kept
MSE_clean   # use this for downstream analysis, dimensionality reduction, etc.`}</CodeBlock>

          <h3 className="text-sm font-medium text-gray-300 mt-4">Config reference:</h3>
          <ImportOptionTable />
        </Section>

        {/* Tips */}
        <Section title="Tips">
          <ul className="space-y-3 text-sm text-gray-300">
            <li className="flex gap-2">
              <span className="text-brand-orange flex-shrink-0">•</span>
              <span><strong className="text-white">Large datasets:</strong> The export script prints rate and ETA every 100 ions. A 5,000-ion dataset with 100k pixels typically takes a few minutes.</span>
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
              <span><strong className="text-white">m/z matching:</strong> The import script uses exact float matching (the m/z values are bit-for-bit identical round-tripping through R → PostgreSQL → CSV → R). A nearest-neighbour fallback within 0.001 Da handles edge cases and warns you if it triggers.</span>
            </li>
            <li className="flex gap-2">
              <span className="text-brand-orange flex-shrink-0">•</span>
              <span><strong className="text-white">Multiple annotators:</strong> If several people annotated the same ion, set <code className="rounded bg-gray-800 px-1 text-green-300">multi_annotator = "last"</code> to keep the most recent label, or <code className="rounded bg-gray-800 px-1 text-green-300">"first"</code> to keep whichever appears first in the CSV.</span>
            </li>
            <li className="flex gap-2">
              <span className="text-brand-orange flex-shrink-0">•</span>
              <span>
                <strong className="text-white">Subsetting m/z range before export:</strong>
                <CodeBlock>{'msi_subset <- MSE_process[mz(MSE_process) > 700 & mz(MSE_process) < 900, ]\n# then set msi_object = "msi_subset" in the export config'}</CodeBlock>
              </span>
            </li>
          </ul>
        </Section>

      </main>
    </div>
  )
}
