import { useCallback, useEffect, useState } from 'react'
import type { JvmRoutes, RouteResult } from './routeTypes'
import { sharedEngine } from './engineClient'
import { copyText, sendReport } from '../spike/report'

/**
 * GPX parity check: replays the JVM reference corpus through the Wasm engine and compares
 * each route's GPX by byte length and CRC-32.
 *
 * Runs against whatever tiles are **already on the phone** — from a region download or a
 * manual import, this panel doesn't care which — and never fetches anything itself. A case
 * whose tile is missing reports that plainly rather than quietly fetching it, which is the
 * honest behaviour and also what makes a missing-tile failure distinguishable from a real
 * parity failure.
 */
export default function RoutePanel() {
  const [reference, setReference] = useState<JvmRoutes | null>(null)
  const [results, setResults] = useState<RouteResult[]>([])
  const [diagnostics, setDiagnostics] = useState<Record<string, string | number> | null>(null)
  const [status, setStatus] = useState('idle')
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [sent, setSent] = useState<string | null>(null)

  // Module-level and stable, so it is safe to reference from hooks.
  const engine = sharedEngine

  useEffect(() => {
    fetch(new URL('engine/jvm-routes.json', document.baseURI))
      .then((r) => {
        if (!r.ok) throw new Error(`no jvm-routes.json (${r.status}) — ./gradlew jvmRoutes`)
        return r.json() as Promise<JvmRoutes>
      })
      .then(setReference)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  const run = useCallback(async (ref: JvmRoutes) => {
    setRunning(true)
    setResults([])
    setError(null)
    try {
      setStatus('loading engine…')
      const diag = await engine().diagnostics()
      setDiagnostics({ ...diag })

      const collected: RouteResult[] = []
      for (const route of ref.routes) {
        setStatus(`routing ${route.id}…`)
        const outcome = await engine().route(route.profile, route.lonLats)
        const result: RouteResult = outcome.ok
          ? {
              ...route,
              wasmMs: outcome.ms,
              actualLength: outcome.gpxLength,
              actualCrc32: outcome.gpxCrc32,
              matches:
                outcome.gpxCrc32 === route.gpxCrc32 && outcome.gpxLength === route.gpxLength,
            }
          : { ...route, wasmMs: outcome.ms, error: outcome.error }
        collected.push(result)
        setResults([...collected])
      }
      setStatus(`done — ${collected.filter((r) => r.matches).length}/${collected.length} byte-identical`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('failed')
    } finally {
      setRunning(false)
    }
  }, [engine])

  const allMatch = results.length > 0 && results.every((r) => r.matches)
  const missingTiles = [
    ...new Set(
      results
        .filter((r) => /not found/.test(r.error ?? ''))
        .flatMap((r) => r.tiles ?? [])
        .filter(Boolean),
    ),
  ]

  return (
    <section>
      <h2>
        GPX parity{' '}
        {results.length > 0 && (
          <span className={`badge ${allMatch ? 'good' : 'bad'}`}>
            {allMatch ? 'byte-identical' : 'mismatch'}
          </span>
        )}
      </h2>
      <p className="sub">
        BRouter's real <code>RoutingEngine</code> on WasmGC, reading whatever tiles are already
        on the phone — from a region download or an import, it doesn't care which. Each route is
        compared to the JVM by GPX byte length and CRC-32. Get the tiles a case needs onto the
        phone first — this panel never fetches them itself.
      </p>

      <p className="meta">status: {status}</p>
      {error && <p className="error">{error}</p>}
      {missingTiles.length > 0 && (
        <p className="error">Missing tiles — import these first: {missingTiles.join(', ')}</p>
      )}

      {diagnostics && (
        <p className="note">
          vfs: {diagnostics.vfsList} | trekking.brf={diagnostics.profile} | max recursion depth=
          {diagnostics.maxDepth}
        </p>
      )}

      {results.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>route</th>
              <th>JVM</th>
              <th>Wasm</th>
              <th>bytes</th>
              <th>crc32</th>
              <th aria-label="result" />
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.id} className={r.matches ? undefined : 'fail'}>
                <td>
                  <code>{r.id}</code>
                  <span className="note">
                    {r.profile}
                    {r.tiles?.length ? ` · ${r.tiles.join('+')}` : ''} · {r.note}
                  </span>
                </td>
                <td>{r.jvmMs} ms</td>
                <td>{r.wasmMs} ms</td>
                <td>
                  {r.error ? '—' : <code>{r.actualLength}</code>}
                  {!r.error && r.actualLength !== r.gpxLength && (
                    <span className="note">expected {r.gpxLength}</span>
                  )}
                </td>
                <td>
                  {r.error ? '—' : <code>{r.actualCrc32}</code>}
                  {!r.error && r.actualCrc32 !== r.gpxCrc32 && (
                    <span className="note">expected {r.gpxCrc32}</span>
                  )}
                </td>
                <td>{r.error ? '❌' : r.matches ? '✅' : '❌'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {results.some((r) => r.error) && (
        <p className="error">
          {results
            .filter((r) => r.error)
            .map((r) => `${r.id}: ${r.error}`)
            .join('\n')}
        </p>
      )}

      <div className="actions">
        <button disabled={running || !reference} onClick={() => reference && run(reference)}>
          {running ? 'Running…' : results.length ? 'Run again' : 'Run parity check'}
        </button>
        <button
          disabled={running || results.length === 0}
          onClick={async () => {
            const md = parityReport(results, diagnostics)
            try {
              setSent(`Sent → ${await sendReport(md)}`)
            } catch {
              setSent((await copyText(md)) ? 'Copied ✓' : 'Could not send or copy')
            }
          }}
        >
          Send report
        </button>
        {sent && <p className="meta">{sent}</p>}
      </div>
    </section>
  )
}

/** Renders the run as markdown, for pasting into docs. */
function parityReport(
  results: RouteResult[],
  diagnostics: Record<string, string | number> | null,
): string {
  const lines = ['## GPX parity run', '']
  lines.push(`- **userAgent:** ${navigator.userAgent}`)
  lines.push(
    `- **home-screen (standalone):** ${
      window.matchMedia('(display-mode: standalone)').matches ? 'yes' : 'no'
    }`,
  )
  if (diagnostics) {
    lines.push(`- **max Java recursion depth (worker):** ${diagnostics.maxDepth}`)
    lines.push(`- **vfs trekking.brf:** ${diagnostics.profile}`)
  }
  lines.push('')
  lines.push('| route | profile | tiles | JVM | Wasm | ratio | bytes | crc32 | byte-identical |')
  lines.push('|---|---|---|---|---|---|---|---|---|')
  for (const r of results) {
    const tiles = r.tiles?.join('+') ?? ''
    if (r.error) {
      lines.push(`| \`${r.id}\` | ${r.profile} | ${tiles} | ${r.jvmMs} ms | ${r.wasmMs} ms | — | — | — | ERROR: ${r.error} |`)
      continue
    }
    const ratio = r.jvmMs > 0 ? (r.wasmMs / r.jvmMs).toFixed(2) + 'x' : '—'
    lines.push(
      `| \`${r.id}\` | ${r.profile} | ${tiles} | ${r.jvmMs} ms | ${r.wasmMs} ms | ${ratio} | ${r.actualLength} | ${r.actualCrc32} | ${r.matches ? 'yes' : 'NO'} |`,
    )
  }
  return lines.join('\n')
}
