import { useCallback, useRef, useState } from 'react'
import type { BackendId, BackendReport, JvmReference } from './types'
import { loadJvmReference, runBackendInWorker } from './runSpike'
import { copyText, reportAsMarkdown, sendReport } from './report'

const BACKENDS: { id: BackendId; label: string; blurb: string }[] = [
  {
    id: 'wasm-gc',
    label: 'WasmGC',
    blurb: "TeaVM 0.15's only Wasm backend",
  },
  {
    id: 'js',
    label: 'JS fallback',
    blurb: 'Same Java source, JS backend — proven from day one, not retrofitted after a regression',
  },
]

/**
 * Spike 1's kernel parity and benchmark harness.
 *
 * No longer runs on load. It did while it was the whole app; now that it lives behind a tab
 * in a route planner, starting a CPU-bound benchmark every time someone opens Setup would
 * make the app feel broken and would flatten a battery that has a ride to get through.
 */
export default function SpikePanel({ notes }: { notes: Record<string, string> }) {
  const [reference, setReference] = useState<JvmReference | null>(null)
  const [reports, setReports] = useState<Partial<Record<BackendId, BackendReport>>>({})
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const started = useRef(false)

  const run = useCallback(async () => {
    setRunning(true)
    setReports({})
    setError(null)
    try {
      const ref = reference ?? (await loadJvmReference())
      setReference(ref)
      // Sequentially, not in parallel: they share the CPU and these are timings.
      for (const { id } of BACKENDS) {
        const report = await runBackendInWorker(id, ref)
        setReports((prev) => ({ ...prev, [id]: report }))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
      started.current = true
    }
  }, [reference])

  return (
    <section>
      <h2>Kernel parity</h2>
      <p className="sub">
        Real BRouter compute (CheapRuler, SortedHeap, Crc32) compiled Java&nbsp;→&nbsp;WasmGC and
        run in a Web&nbsp;Worker, checked bit-for-bit against the JVM. This is Spike&nbsp;1; it
        touches no files and no routing data.
      </p>

      {error && <p className="error">{error}</p>}

      <div className="actions">
        <button disabled={running} onClick={() => void run()}>
          {running ? 'Running…' : started.current ? 'Run again' : 'Run parity check'}
        </button>
        <SendReportButton
          disabled={running || Object.keys(reports).length === 0}
          markdown={() => reportAsMarkdown(reports, notes, reference)}
        />
        <CopyReportButton
          disabled={running || Object.keys(reports).length === 0}
          markdown={() => reportAsMarkdown(reports, notes, reference)}
        />
      </div>

      {BACKENDS.map(({ id, label, blurb }) => (
        <BackendSection key={id} label={label} blurb={blurb} report={reports[id]} />
      ))}
    </section>
  )
}

/**
 * Posts the run straight back to the dev machine, so results measured on a phone land in
 * `docs/spike-runs/` without anyone retyping hex digits.
 */
function SendReportButton({ disabled, markdown }: { disabled: boolean; markdown: () => string }) {
  const [status, setStatus] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  const send = async () => {
    setStatus('Sending…')
    setFailed(false)
    try {
      setStatus(`Sent to ${await sendReport(markdown())}`)
    } catch (error) {
      setFailed(true)
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <>
      <button disabled={disabled} onClick={send}>
        Send to laptop
      </button>
      {status && <p className={failed ? 'error' : 'meta'}>{status}</p>}
    </>
  )
}

/**
 * Copies the run as markdown. Falls back to showing the text for manual selection, because
 * clipboard writes can be refused (non-secure context, or a WebKit gesture heuristic) and
 * silently losing the phone's results would be the worst outcome.
 */
function CopyReportButton({ disabled, markdown }: { disabled: boolean; markdown: () => string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'fallback'>('idle')
  const [text, setText] = useState('')

  const copy = async () => {
    const md = markdown()
    setText(md)
    if (await copyText(md)) {
      setState('copied')
      setTimeout(() => setState('idle'), 2000)
    } else {
      setState('fallback')
    }
  }

  return (
    <>
      <button disabled={disabled} onClick={copy}>
        {state === 'copied' ? 'Copied' : 'Copy report'}
      </button>
      {state === 'fallback' && (
        <>
          <p className="meta">Clipboard refused. Select and copy this instead:</p>
          <textarea readOnly rows={16} value={text} onFocus={(e) => e.currentTarget.select()} />
        </>
      )}
    </>
  )
}

function BackendSection({
  label,
  blurb,
  report,
}: {
  label: string
  blurb: string
  report?: BackendReport
}) {
  if (!report) return null

  return (
    <section>
      <h3>
        {label} <StatusBadge report={report} />
      </h3>
      <p className="sub">{blurb}</p>

      {report.error && <p className="error">{report.error}</p>}

      {!report.error && (
        <>
          <p className="meta">loaded and instantiated in {report.loadMs} ms</p>

          <table>
            <thead>
              <tr>
                <th>case</th>
                <th>expected (JVM)</th>
                <th>actual</th>
                <th aria-label="result" />
              </tr>
            </thead>
            <tbody>
              {report.cases.map((c) => (
                <tr key={c.id} className={c.pass ? undefined : 'fail'}>
                  <td>
                    <code>{c.id}</code>
                    <span className="note">{c.note}</span>
                  </td>
                  <td>
                    <code>{c.expected}</code>
                  </td>
                  <td>
                    <code>{c.actual}</code>
                  </td>
                  <td>{c.pass ? 'pass' : 'FAIL'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <table>
            <thead>
              <tr>
                <th>benchmark</th>
                <th>JVM</th>
                <th>{label}</th>
                <th>slowdown</th>
              </tr>
            </thead>
            <tbody>
              {report.benchmarks.map((b) => (
                <tr key={b.id}>
                  <td>
                    <code>{b.id}</code>
                  </td>
                  <td>{b.jvmBestMs} ms</td>
                  <td>{b.backendBestMs} ms</td>
                  <td>
                    <strong>{b.slowdown}×</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  )
}

function StatusBadge({ report }: { report: BackendReport }) {
  if (report.error) return <span className="badge bad">failed</span>
  return report.ok ? (
    <span className="badge good">bit-identical</span>
  ) : (
    <span className="badge bad">mismatch</span>
  )
}
