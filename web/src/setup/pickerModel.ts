/**
 * What the region picker decides, with the pixels left out.
 *
 * Everything here is pure so it can be tested without a browser: the states the outline layer
 * paints from, the sizes a rider reads, the line under the progress bar, and the words a
 * failure is turned into. The screen itself needs a map, a Worker and OPFS, none of which
 * exist under vitest — so anything that can be decided without them is decided here rather
 * than inside JSX, where nothing can reach it.
 *
 * ## The vocabulary is the point of the screen
 *
 * A rider downloads **the map** and **the road data** for **a region**. The file formats, the
 * grid the road data is cut on, and the storage it lands in are all implementation, and none
 * of them belong on this screen. That rule binds hardest on error text, because error text is
 * the one place the implementation writes the copy: `downloadInto` throws with the URL it was
 * fetching in the message, and that URL ends in a file extension nobody should have to read.
 * {@link tidyMessage} is what stops it, and it is why every failure path goes through
 * {@link downloadFailure} instead of rendering `error.message` directly.
 */

import type { DataManifest, InstalledRegion, RegionEntry } from '../data/manifest'
import { downloadPlan, regionState, type RegionState } from '../data/regions'
import type { RegionProgress } from '../engine/downloads'
import type { Handback } from '../map/archiveChoice'

/**
 * A size as a rider reads it: whole megabytes, decimal not binary.
 *
 * Decimal because that is the number the phone's own storage settings show, and a rider
 * deciding whether to start a 137 MB download over a hotel wifi is comparing against that,
 * not against a figure only a programmer would recognise.
 *
 * One decimal place below 10 MB, because "0 MB" for a 400 kB file is a lie in the direction
 * that matters least but is still a lie. Nothing in the manifest is small enough for this to
 * come up, which is exactly why it is worth pinning down here rather than discovering later.
 */
export function formatMegabytes(bytes: number): string {
  const mb = bytes / 1e6
  if (mb === 0) return '0 MB'
  if (mb < 0.1) return 'under 0.1 MB'
  if (mb < 10) return `${mb.toFixed(1)} MB`
  return `${Math.round(mb)} MB`
}

/** The two things a rider is downloading, in the only words this screen uses for them. */
export function itemWords(kind: RegionProgress['kind']): string {
  return kind === 'basemap' ? 'the map' : 'the road data'
}

/**
 * Whether this phone has enough to ride on, and so whether the picker should stand down.
 *
 * A region record is the modern answer. The second half is the phone that was set up before
 * regions existed and imported its two files by hand: it has no record, but it has everything
 * it needs, and sending it to the picker would be telling a rider who is already riding that
 * they have not started.
 *
 * It is also the way *out* of the picker's dead end. A rider who reaches the "no list of
 * regions" state and takes the manual route needs this asked again when Setup closes —
 * otherwise they import both files, press Done, and land back on a screen that still says
 * there is nothing to choose from. A home-screen app has no address bar to reload from, so
 * "force-quit the app" was the only exit that screen had.
 */
export function readyToRide(counts: {
  regions: number
  basemaps: number
  roadData: number
}): boolean {
  return counts.regions > 0 || (counts.basemaps > 0 && counts.roadData > 0)
}

/** Why the picker has nothing to offer. */
export interface CatalogueFailure {
  cause: 'storage' | 'list'
  reason: string
}

/** Just enough of a `PromiseSettledResult` to decide on, and to write a test against. */
type Settled = { status: 'fulfilled' } | { status: 'rejected'; reason: unknown }

/**
 * Which of the two things the screen needs actually failed.
 *
 * They are fetched together, so both can fail at once — and the headline has to name the
 * right one. "free-wheel could not reach the internet" printed over a storage fault is a
 * false statement that sends a rider to look at their wifi; per `CLAUDE.md`, `navigator.storage`
 * is `undefined` rather than merely restricted on a plain-http origin, which is a condition
 * this project's own LAN device-testing workflow walks into.
 *
 * Storage wins when both fail, because it is the more fundamental of the two: a phone that
 * cannot reach its own storage cannot download a region even with a perfect list, and cannot
 * import one by hand either.
 */
export function pickerFailure(list: Settled, storage: Settled): CatalogueFailure | null {
  if (storage.status === 'rejected') return { cause: 'storage', reason: tidyMessage(storage.reason) }
  if (list.status === 'rejected') return { cause: 'list', reason: tidyMessage(list.reason) }
  return null
}

/** The words for each, so the headline cannot drift from the fault it describes. */
export function failureCopy(cause: CatalogueFailure['cause']): {
  heading: string
  explanation: string
  action: string
} {
  if (cause === 'storage') {
    return {
      heading: 'free-wheel cannot reach this phone’s storage',
      explanation:
        'Nothing can be saved here until it can, so there is no point offering you a download. This is usually an app opened over an insecure connection, or a second copy of free-wheel open in another tab.',
      action: 'Open Setup',
    }
  }
  return {
    heading: 'There is no list of regions on this phone yet',
    explanation:
      'free-wheel could not reach the internet, and it has never saved a copy of the list. Connect to a network and open the app again, or set it up by hand.',
    action: 'Set up by hand',
  }
}

/**
 * Whether the picker may stand down on a given handback.
 *
 * The picker borrows the one MapLibre instance the whole app shares, and every exit has to
 * give it back before the ride screen's effects wake up. Three of the four outcomes of that
 * handback are fine to leave on, and the rule is *not* "did it restore a map":
 *
 * - `restored` — obviously.
 * - `nothing-installed` — an empty phone that chose to carry on without a region. The map is
 *   torn down and the ride screen has copy for exactly this. Blocking here would rebuild the
 *   dead end the picker exists to remove.
 * - `unavailable` — the handback could not be completed. The borrowed map is down, so nothing
 *   is masquerading as the rider's own, but nobody has been told why and the one thing that
 *   might fix it (closing a second copy of the app) is not something the ride screen can ask
 *   for. The picker holds, says so, and offers a retry.
 */
export function mayStandDown(outcome: Handback): boolean {
  return outcome !== 'unavailable'
}

/**
 * The words for a handback that could not be completed.
 *
 * Its own copy rather than {@link failureCopy}'s, because it is its own fault: the list
 * arrived, the phone may well have a perfectly good map on it, and what failed was reading
 * the record of what is there. The remedy is the one this repo has already written down —
 * only one copy of the app can hold a storage handle, and a second tab is how that collides —
 * so the explanation says that rather than sending anyone to look at their wifi.
 */
export function handbackCopy(): {
  heading: string
  explanation: string
  retry: string
  carryOn: string
} {
  return {
    heading: 'free-wheel could not open your map',
    explanation:
      'It could not read what is saved on this phone, so there is nothing to put on screen. If free-wheel is open in another tab, close that tab — only one copy can use this phone’s storage at a time — and try again.',
    retry: 'Try again',
    carryOn: 'Carry on anyway',
  }
}

/** One region, priced and described, ready to put on screen. */
export interface RegionSummary {
  id: string
  name: string
  state: RegionState
  /** Bytes still to fetch. Zero when everything this region needs is already here. */
  bytes: number
  /** {@link bytes} as a rider reads it. */
  size: string
  /** What is already here, or `null` when nothing is. */
  status: string | null
  /** The sentence that sits in front of the button. */
  price: string
  /** What the button says. */
  action: string
  /** Kept so the caller can hand it straight back to the engine and to the outline layer. */
  region: RegionEntry
}

/**
 * Every region the manifest offers, priced against what this phone already holds.
 *
 * A region whose price cannot be worked out is left out rather than shown without one. That
 * needs `downloadPlan` to throw, which needs a region naming a piece of road data the manifest
 * does not describe — something `parseManifest` already rejects, so this is unreachable through
 * the front door. It is caught anyway because the alternative is a throw during render, and
 * this screen's one hard promise is that it never shows a rider a blank page. A region nobody
 * can price is a region nobody can honestly offer; the rest of the list still works.
 */
export function summarise(
  manifest: DataManifest,
  installed: InstalledRegion[],
  manifestIsFresh: boolean,
): RegionSummary[] {
  const summaries: RegionSummary[] = []
  for (const region of manifest.regions) {
    const mine = installed.find((r) => r.id === region.id)
    const state = regionState(region, mine, manifestIsFresh, manifest.segments)
    let bytes: number
    try {
      bytes = downloadPlan(region, manifest, installed).bytes
    } catch {
      continue
    }
    summaries.push({
      id: region.id,
      name: region.name,
      state,
      bytes,
      size: formatMegabytes(bytes),
      status: statusLine(state),
      price: priceLine(state, bytes, formatMegabytes(bytes)),
      action: actionLabel(state, bytes),
      region,
    })
  }
  return summaries
}

/** The shape `regionsGeoJson` wants, derived from the same summaries the list is built from. */
export function statesOf(summaries: RegionSummary[]): Record<string, RegionState> {
  return Object.fromEntries(summaries.map((s) => [s.id, s.state]))
}

/**
 * What is already on the phone for this region, in a sentence, or `null` for a region with
 * nothing here yet — where a status line would only be noise.
 *
 * `unknown` says so out loud. An offline phone cannot tell whether its copy is current, and
 * the cost of guessing "current" is a rider following road data that no longer matches the
 * roads.
 */
export function statusLine(state: RegionState): string | null {
  switch (state) {
    case 'not-installed':
      return null
    case 'current':
      return 'Already on this phone, and up to date.'
    case 'road-data-outdated':
      return 'The road data here has changed since you downloaded it.'
    case 'map-outdated':
      return 'The map here has changed since you downloaded it.'
    case 'unknown':
      return 'Already on this phone. Without a connection there is no way to check whether it is still up to date.'
  }
}

/**
 * The label on the one button in the sheet.
 *
 * Keyed on the price rather than only on the state, because the price is what the tap costs.
 * A region can be `road-data-outdated` and still have nothing to fetch — another region
 * already downloaded the road data it shares — and offering to "Update" 0 MB reads as broken.
 */
export function actionLabel(state: RegionState, bytes: number): string {
  if (bytes === 0) return 'Use this region'
  return state === 'not-installed' ? 'Download' : 'Update'
}

/**
 * The size, in the sentence that goes in front of the button.
 *
 * In front, and not behind: Safari implements no `NetworkInformation`, so there is no honest
 * way to tell whether a rider is on wifi or on a metered plan with a fortnight left in the
 * month. Hedging — "this may use a lot of data" — would be inventing a warning we cannot
 * substantiate. The number is the whole of what we know, so the number is what we say, before
 * the tap rather than after it.
 *
 * An update does not claim to be fetching both halves. A region whose map is current and whose
 * road data is not costs only the road data, and saying otherwise would overstate the price of
 * the one tap on the screen.
 */
export function priceLine(state: RegionState, bytes: number, size: string): string {
  if (bytes === 0) return 'Everything this region needs is already on the phone.'
  if (state === 'not-installed') return `${size} — the map and the road data for this area.`
  return `${size} to bring this region up to date.`
}

/**
 * The price line above the button, or nothing.
 *
 * Nothing after a failure, and that is the whole of this function. `price` is the cost of the
 * *whole* region, worked out when the screen loaded; a download that died at 130 of 137 MB
 * will resume, so repeating the full figure one line above advice that says the retry picks up
 * where it stopped puts two contradictory sentences next to each other. The honest remaining
 * number is known only to the engine, which recomputes it from what is on disk at the start of
 * the next attempt — so the advice carries it and the stale price gets out of the way.
 */
export function sheetPrice(price: string, failed: boolean): string | null {
  return failed ? null : price
}

export interface DownloadStatus {
  /** 0–100, for the bar and for `aria-valuenow`. */
  percent: number
  /** The line under the bar. */
  line: string
}

/**
 * The bar and the line beneath it.
 *
 * The bar tracks the *region*, not the file: `overallReceived / overallTotal` is the only
 * number that keeps moving forward across a basemap and several pieces of road data, and a bar
 * that restarts from zero three times reads as three failures. The line names the file, in
 * words, so the bar's slow patch has an explanation.
 *
 * `overallTotal` of zero is a region with nothing to fetch, which finishes without ever
 * reporting progress; it is guarded because dividing by it would put `NaN` in the style
 * attribute and collapse the bar rather than fill it.
 */
export function downloadStatus(progress: RegionProgress | null): DownloadStatus {
  if (!progress) return { percent: 0, line: 'Starting…' }

  const percent =
    progress.overallTotal > 0
      ? Math.min(100, Math.max(0, Math.round((progress.overallReceived / progress.overallTotal) * 100)))
      : 0

  // Everything asked for is down, but the region is not committed until the engine has
  // finished recording it — a beat during which a bar pinned at 100% with a "downloading"
  // label underneath would be the one thing on screen that is not true.
  if (progress.state === 'complete' && progress.overallReceived >= progress.overallTotal) {
    return { percent, line: 'Finishing up…' }
  }

  return {
    percent,
    line: `Downloading ${itemWords(progress.kind)} — ${formatMegabytes(progress.received)} of ${formatMegabytes(progress.total)}`,
  }
}

/**
 * Words this screen does not use, whatever an exception thinks.
 *
 * Every one of these is reachable in a message a rider could end up reading. `downloadInto`
 * prefixes its throws with the URL it was fetching, and that URL ends in a file extension.
 * `parseManifest` rejects a bad cached copy with "segment name … is not a valid grid cell
 * id". The virtual filesystem talks about tiles. None of it is wrong; all of it is the
 * vocabulary this screen exists so that nobody has to learn.
 */
const IMPLEMENTATION_WORDS: [RegExp, string][] = [
  [/\.rd5\b/gi, ''],
  [/\.pmtiles\b/gi, ''],
  [/\bsegments?\d*\b/gi, 'road data'],
  [/\bOPFS\b/gi, 'storage'],
  [/\btiles?\b/gi, 'map data'],
]

/**
 * The same vocabulary again, and deliberately looser than the substitutions above: no word
 * boundaries, so a form the scrub did not anticipate — a compound, a capitalised identifier —
 * still trips it. False positives cost a diagnostic; a false negative costs the rule.
 */
const LEAKED = /rd5|pmtiles|segment|opfs|tile/i

/**
 * An error message with the implementation taken out of it.
 *
 * Deliberately a scrub rather than a whitelist of messages we recognise. An unrecognised
 * message still has to reach the screen: a rider reporting "it said X" is the only diagnostic
 * a phone in a field produces, and swallowing every message we did not anticipate throws that
 * away to protect copy that a substitution can protect just as well.
 *
 * The last line is the guarantee. If a word got through anyway — a message nobody has written
 * yet, phrased in a way these patterns miss — the message is dropped rather than shown,
 * because the copy rule is the point of the screen and a diagnostic is not.
 */
export function tidyMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  let message = raw
    // The `<url>: <what went wrong>` prefix `downloadInto` throws with.
    .replace(/https?:\/\/\S+?:\s+/g, '')
    // Any URL left over, including one at the end of a sentence.
    .replace(/https?:\/\/\S+/g, 'the download')
  for (const [pattern, replacement] of IMPLEMENTATION_WORDS) {
    message = message.replace(pattern, replacement)
  }
  message = message.replace(/\s{2,}/g, ' ').replace(/\s+([,.:;])/g, '$1').trim()
  if (message.length === 0 || LEAKED.test(message)) return 'something went wrong'
  return message
}

/**
 * The download finished and the archive would not mount.
 *
 * A marker rather than an error, because it is not one that was thrown: `show` reports a
 * failed mount by answering `false`, and the same storage collision that breaks a handback
 * breaks this. It matters because the honest sentence is the opposite of every other branch
 * below — the bytes are *here*, and a rider told "the download stopped" may well decide to
 * spend the whole region again over mobile data.
 */
export const MAP_WOULD_NOT_OPEN = 'map-would-not-open'

export interface DownloadFailure {
  /** What happened, in one sentence. */
  message: string
  /** What to do about it, or `null` when there is nothing useful to say. */
  advice: string | null
}

/**
 * A failed download, turned into something a rider can act on.
 *
 * Every branch says the same reassuring thing in different words, because it is the fact that
 * most changes what a rider does next: **a retry resumes**. The partial bytes and the marker
 * describing them are already on disk, and the engine recomputes what to do from them on every
 * attempt — so a 137 MB download that died at 130 MB costs 7 MB to finish, not 137. A rider who
 * does not know that will not press Retry on a train.
 *
 * Quota is called out separately because it is the one failure a retry alone cannot fix.
 */
export function downloadFailure(error: unknown): DownloadFailure {
  if (error === MAP_WOULD_NOT_OPEN) {
    return {
      message: 'The download finished, but the map would not open.',
      advice:
        'Nothing needs fetching again — it is all on the phone. If free-wheel is open in another tab, close that tab and try again.',
    }
  }

  const name = error instanceof Error ? error.name : ''
  const message = tidyMessage(error)

  if (name === 'QuotaExceededError' || /quota|not enough space|storage is full/i.test(message)) {
    return {
      message: 'There is not enough room left on this phone.',
      advice:
        'Free some space — removing a region you no longer ride in is the quickest way — then try again. What has already come down is kept, so a retry picks up where it stopped.',
    }
  }

  if (/failed to fetch|load failed|network|connection|offline/i.test(message)) {
    return {
      message: 'The connection dropped.',
      advice: 'What has already come down is kept. Try again and it picks up where it stopped.',
    }
  }

  const status = /returned (\d{3})/.exec(message)
  if (status) {
    return {
      message: `The download server answered ${status[1]}.`,
      advice: 'Nothing is wrong with this phone. Try again in a minute.',
    }
  }

  if (/expected \d+ bytes, wrote \d+/.test(message)) {
    return {
      message: 'The download stopped before it finished.',
      advice: 'What has already come down is kept. Try again and it picks up where it stopped.',
    }
  }

  return {
    message: `The download stopped: ${message}.`,
    advice: 'What has already come down is kept, so a retry picks up where it stopped.',
  }
}
