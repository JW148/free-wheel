import type { BackendId, BackendReport, JvmReference } from './types'

/**
 * Copies text, coping with the fact that Spike 1 is served over plain HTTP on the
 * LAN and `navigator.clipboard` is secure-context-only — on the phone it is simply
 * `undefined`. Falls back to the legacy `execCommand` path, which still works on
 * insecure origins, using the selection dance iOS Safari specifically requires.
 *
 * @returns whether the text made it to the clipboard
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through — a rejected permission is not a reason to give up.
  }

  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    // iOS ignores off-screen or readonly textareas, but will happily copy from a
    // contentEditable one; keep it visually inert rather than hidden.
    textarea.contentEditable = 'true'
    textarea.readOnly = false
    textarea.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;'
    document.body.appendChild(textarea)

    const range = document.createRange()
    range.selectNodeContents(textarea)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    textarea.setSelectionRange(0, text.length)

    const copied = document.execCommand('copy')
    document.body.removeChild(textarea)
    return copied
  } catch {
    return false
  }
}

/**
 * POSTs the report to `tools/report-server.mjs`, which writes it into
 * `docs/spike-runs/`. Only available when the app is served by that script rather
 * than `vite preview`; the caller surfaces the failure so the copy path stays usable.
 *
 * @returns the repo-relative path it was saved to
 */
export async function sendReport(markdown: string): Promise<string> {
  const response = await fetch(new URL('spike-report', document.baseURI), {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=utf-8' },
    body: markdown,
  })

  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? 'No report endpoint — served by `vite preview`? Use `npm run spike-server` instead.'
        : `Server returned ${response.status}`,
    )
  }

  const { saved } = (await response.json()) as { saved?: string }
  return saved ?? 'docs/spike-runs/'
}

/**
 * Renders the run as markdown for pasting straight into `docs/spike-1-results.md`.
 *
 * This exists because the acceptance criteria are verified on a phone, and reading
 * 16 hex digits off a phone screen and retyping them is both miserable and exactly
 * the sort of thing that produces a false "matches".
 */
export function reportAsMarkdown(
  reports: Partial<Record<BackendId, BackendReport>>,
  notes: Record<string, string>,
  reference: JvmReference | null,
): string {
  const lines: string[] = []

  lines.push('## Spike 1 run')
  lines.push('')
  for (const [key, value] of Object.entries(notes)) {
    lines.push(`- **${key}:** ${value}`)
  }
  lines.push(`- **reference:** ${reference?.generatedBy ?? 'unknown'}`)
  lines.push('')

  for (const [backend, report] of Object.entries(reports) as [BackendId, BackendReport][]) {
    lines.push(`### ${backend}`)
    lines.push('')

    if (report.error) {
      lines.push(`**FAILED:** ${report.error}`)
      lines.push('')
      continue
    }

    lines.push(`Loaded in ${report.loadMs} ms. ${report.ok ? 'All cases bit-identical.' : '**MISMATCH.**'}`)
    lines.push('')
    lines.push('| case | expected | actual | |')
    lines.push('|---|---|---|---|')
    for (const c of report.cases) {
      lines.push(`| \`${c.id}\` | \`${c.expected}\` | \`${c.actual}\` | ${c.pass ? 'ok' : 'FAIL'} |`)
    }
    lines.push('')
    lines.push('| benchmark | JVM | this | slowdown |')
    lines.push('|---|---|---|---|')
    for (const b of report.benchmarks) {
      lines.push(`| \`${b.id}\` | ${b.jvmBestMs} ms | ${b.backendBestMs} ms | ${b.slowdown}x |`)
    }
    lines.push('')
  }

  return lines.join('\n')
}
