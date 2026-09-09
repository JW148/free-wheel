/**
 * Hands a GPX document to the OS.
 *
 * `navigator.share` with a `File` is the one that matters on iOS: it puts the route into
 * Files, Mail, or another cycling app in two taps, and there is no other way for a web app to
 * do that. The `<a download>` fallback covers desktop, where sharing a file is often
 * unsupported.
 *
 * Extracted from `RouteSheet` when the ride summary needed the same thing. A planned route and
 * a recorded ride are different documents produced by different code, but getting either off
 * the phone is one problem with one answer.
 */
export async function shareGpx(gpx: string, basename: string): Promise<void> {
  const file = new File([gpx], `${basename}.gpx`, { type: 'application/gpx+xml' })

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'free-wheel' })
      return
    } catch (error) {
      // A cancelled share sheet rejects. That is a choice, not a failure — only fall through
      // to a download if something actually went wrong.
      if (error instanceof DOMException && error.name === 'AbortError') return
    }
  }

  const url = URL.createObjectURL(file)
  const link = document.createElement('a')
  link.href = url
  link.download = file.name
  link.click()
  URL.revokeObjectURL(url)
}

/** `free-wheel-trekking-2026-09-08-21-14` — sortable, and says what it is. */
export function gpxFilename(kind: string, at: number = Date.now()): string {
  const stamp = new Date(at).toISOString().slice(0, 16).replace(/[:T]/g, '-')
  return `free-wheel-${kind}-${stamp}`
}
