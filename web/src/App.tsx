import { useCallback, useEffect, useRef, useState } from 'react'
import type { BackendId, BackendReport, JvmReference } from './spike/types'
import { environmentNotes, loadJvmReference, runBackendInWorker } from './spike/runSpike'
import { copyText, reportAsMarkdown, sendReport } from './spike/report'
import RoutePanel from './engine/RoutePanel'
import TilesPanel from './engine/TilesPanel'
import MapPanel from './map/MapPanel'
import './App.css'

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

export default function App() {
  const [reference, setReference] = useState<JvmReference | null>(null)
  const [reports, setReports] = useState<Partial<Record<BackendId, BackendReport>>>({})
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [autoSent, setAutoSent] = useState<string | null>(null)
  const notes = environmentNotes()
  // StrictMode double-invokes effects in dev; without this the spike runs twice
  // and the two runs contend for the CPU, which corrupts the timings.
  const autoRan = useRef(false)

  const run = useCallback(async (ref: JvmReference) => {
    setRunning(true)
    setReports({})
    // Sequentially, not in parallel: they share the CPU and these are timings.
    const collected: Partial<Record<BackendId, BackendReport>> = {}
    for (const { id } of BACKENDS) {
      const report = await runBackendInWorker(id, ref)
      collected[id] = report
      setReports((prev) => ({ ...prev, [id]: report }))
    }
    setRunning(false)
    return collected
  }, [])

  useEffect(() => {
    if (autoRan.current) return
    autoRan.current = true

    loadJvmReference()
      .then(async (ref) => {
        setReference(ref)
        const collected = await run(ref)

        // `?autosend` lets a browser be driven from the command line and still report
        // back — used to capture desktop Safari, which can't be scripted without
        // enabling "Allow JavaScript from Apple Events".
        if (!new URLSearchParams(window.location.search).has('autosend')) return
        try {
          const saved = await sendReport(reportAsMarkdown(collected, environmentNotes(), ref))
          setAutoSent(`Auto-sent → ${saved}`)
        } catch (e) {
          setAutoSent(`Auto-send failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [run])

  return (
    <main>
      <header>
        <h1>Spike 1 — TeaVM toolchain proof</h1>
        <p className="sub">
          Real BRouter compute (CheapRuler, SortedHeap, Crc32) compiled Java&nbsp;→&nbsp;WasmGC and
          run in a Web&nbsp;Worker. No file I/O, no <code>.rd5</code>, no routing engine — those are
          Phase&nbsp;1.
        </p>
      </header>

      {error && <p className="error">{error}</p>}
      {autoSent && <p className="meta">{autoSent}</p>}

      <section>
        <h2>Environment</h2>
        <dl className="env">
          {Object.entries(notes).map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
          <div>
            <dt>reference</dt>
            <dd>{reference?.generatedBy ?? 'loading…'}</dd>
          </div>
          <div>
            <dt>build</dt>
            <dd>{__BUILD_ID__}</dd>
          </div>
        </dl>
      </section>

      <MapPanel />

      <TilesPanel />

      <RoutePanel />

      {BACKENDS.map(({ id, label, blurb }) => (
        <BackendSection key={id} label={label} blurb={blurb} report={reports[id]} />
      ))}

      <div className="actions">
        <button disabled={running || !reference} onClick={() => reference && run(reference)}>
          {running ? 'Running…' : 'Run again'}
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
    </main>
  )
}

/**
 * Posts the run straight back to the dev machine, so results measured on a phone
 * land in `docs/spike-runs/` without anyone retyping hex digits.
 */
function SendReportButton({
  disabled,
  markdown,
}: {
  disabled: boolean
  markdown: () => string
}) {
  const [status, setStatus] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  const send = async () => {
    setStatus('Sending…')
    setFailed(false)
    try {
      const saved = await sendReport(markdown())
      setStatus(`Sent → ${saved}`)
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
 * Copies the run as markdown. Falls back to showing the text for manual selection,
 * because clipboard writes can be refused (non-secure context, or a WebKit gesture
 * heuristic) and silently losing the phone's results would be the worst outcome.
 */
function CopyReportButton({
  disabled,
  markdown,
}: {
  disabled: boolean
  markdown: () => string
}) {
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
        {state === 'copied' ? 'Copied ✓' : 'Copy report'}
      </button>
      {state === 'fallback' && (
        <>
          <p className="meta">Clipboard refused — select and copy this:</p>
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
  return (
    <section>
      <h2>
        {label} {report && <StatusBadge report={report} />}
      </h2>
      <p className="sub">{blurb}</p>

      {!report && <p className="pending">waiting…</p>}

      {report?.error && <p className="error">{report.error}</p>}

      {report && !report.error && (
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
                  <td>{c.pass ? '✅' : '❌'}</td>
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
