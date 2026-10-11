/**
 * How hard the app is working, counted where the work happens.
 *
 * ## Why this exists
 *
 * A real ride drained the phone at about 1% a minute with the screen on — roughly 8–10 W, which
 * is a phone running its GPU flat out. Reading the code said the map was redrawing almost
 * continuously, but "reading the code said" is not a measurement, and a fix judged by feel on a
 * battery percentage takes an hour per data point. These counters make the same question
 * answerable in a minute, at a desk or on the phone: how many frames did the map draw, how many
 * compass events arrived and how many of them reached React, how many fixes, how many renders
 * of the riding screen, how many camera moves.
 *
 * ## What it must cost
 *
 * Nothing worth measuring. `count` is called on every map frame and every compass event — sixty
 * a second each — so it is an array index and an add. It allocates nothing, schedules nothing
 * and publishes nothing: the Diagnostics panel polls, for the same reason `sourceStats` is
 * polled. A counter that re-rendered something on every frame would be measuring itself.
 *
 * ## Shape
 *
 * {@link Meter} is pure and takes the clock as an argument, so it is tested without timers.
 * {@link workload} is the app's one instance, a module singleton like `downloadStore`, because
 * the things being counted live in four hooks and a map instance that know nothing of each
 * other. It is also hung off `window` as `freeWheelWorkload`, which is what lets a headless
 * driver — or Safari's Web Inspector on a tethered phone, mid-ride — read it without a screen
 * to read it from: the riding screen has no route to Diagnostics, deliberately.
 */

/** Everything counted. Adding one is adding a name here and a `count` where it happens. */
export const COUNTERS = ['frames', 'orientation', 'heading', 'fixes', 'renders', 'camera'] as const
export type Counter = (typeof COUNTERS)[number]

/** What each counter is, in the words the Diagnostics panel and the report use. */
export const COUNTER_LABELS: Record<Counter, string> = {
  frames: 'map frames drawn',
  orientation: 'compass events received',
  heading: 'compass heading updates',
  fixes: 'GPS fixes',
  renders: 'riding screen renders',
  camera: 'camera moves',
}

/** The rolling window the rates are measured over, in one-second buckets. */
export const WINDOW_S = 60

export interface WorkloadSnapshot {
  /** Whether a ride is in progress, so totals are "this ride so far". */
  riding: boolean
  /** Seconds the totals cover: since the ride started, or since the app did. */
  elapsedS: number
  totals: Record<Counter, number>
  /**
   * Per minute, over the last {@link WINDOW_S} seconds — or over however much of that has
   * elapsed, so the first ten seconds of a ride are not reported as a sixth of their real rate.
   */
  perMinute: Record<Counter, number>
  /** The last finished ride, kept until the next one starts. */
  lastRide: RideWorkload | null
}

export interface RideWorkload {
  durationS: number
  totals: Record<Counter, number>
  /** Totals divided by the whole ride's length, per minute. */
  perMinute: Record<Counter, number>
}

const zeroes = (): Record<Counter, number> =>
  Object.fromEntries(COUNTERS.map((c) => [c, 0])) as Record<Counter, number>

/**
 * Counts, totals and a per-second ring for each counter.
 *
 * The ring is indexed by whole seconds since the epoch modulo {@link WINDOW_S}. Moving into a
 * new second zeroes every bucket skipped since the last count — at most sixty writes, and only
 * once a second — so a counter that went quiet for a minute reads zero rather than whatever it
 * was doing before it stopped.
 */
export class Meter {
  private readonly totals = zeroes()
  private readonly rings: Record<Counter, Int32Array>
  private readonly second: Record<Counter, number>
  private since: number
  private riding = false
  private lastRide: RideWorkload | null = null

  constructor(nowMs: number) {
    this.since = nowMs
    this.rings = Object.fromEntries(
      COUNTERS.map((c) => [c, new Int32Array(WINDOW_S)]),
    ) as Record<Counter, Int32Array>
    this.second = Object.fromEntries(COUNTERS.map((c) => [c, -1])) as Record<Counter, number>
  }

  count(counter: Counter, nowMs: number): void {
    this.totals[counter] += 1
    this.roll(counter, nowMs)
    this.rings[counter][Math.floor(nowMs / 1000) % WINDOW_S] += 1
  }

  /** A ride begins: the totals start again from zero, and the last ride is forgotten. */
  startRide(nowMs: number): void {
    if (this.riding) return
    for (const c of COUNTERS) this.totals[c] = 0
    this.since = nowMs
    this.riding = true
    this.lastRide = null
  }

  /** A ride ends: what it cost is kept as {@link RideWorkload} and the totals carry on. */
  endRide(nowMs: number): void {
    if (!this.riding) return
    const durationS = Math.max(0, (nowMs - this.since) / 1000)
    const minutes = durationS / 60
    const totals = { ...this.totals }
    this.lastRide = {
      durationS,
      totals,
      perMinute: Object.fromEntries(
        COUNTERS.map((c) => [c, minutes > 0 ? totals[c] / minutes : 0]),
      ) as Record<Counter, number>,
    }
    this.riding = false
  }

  snapshot(nowMs: number): WorkloadSnapshot {
    const elapsedS = Math.max(0, (nowMs - this.since) / 1000)
    // The ring holds the current second, which is only partly over, and the 59 before it — so
    // that is the span the sum covers, to the millisecond. Or the part of it there has been: a
    // ride ten seconds old is ten seconds of evidence, and dividing it by sixty would report a
    // sixth of the truth.
    const spanS = WINDOW_S - 1 + (nowMs % 1000) / 1000
    const windowS = Math.max(0.001, Math.min(spanS, elapsedS))
    const perMinute = zeroes()
    for (const c of COUNTERS) {
      this.roll(c, nowMs)
      let sum = 0
      for (const n of this.rings[c]) sum += n
      perMinute[c] = (sum / windowS) * 60
    }
    return {
      riding: this.riding,
      elapsedS,
      totals: { ...this.totals },
      perMinute,
      lastRide: this.lastRide,
    }
  }

  /** Zeroes every bucket between the last second this counter saw and `nowMs`'s. */
  private roll(counter: Counter, nowMs: number): void {
    const now = Math.floor(nowMs / 1000)
    const last = this.second[counter]
    if (now === last) return
    const ring = this.rings[counter]
    if (last < 0 || now - last >= WINDOW_S) ring.fill(0)
    else for (let s = last + 1; s <= now; s++) ring[s % WINDOW_S] = 0
    this.second[counter] = now
  }
}

/**
 * The workload as markdown, for the report the spike server writes into `docs/spike-runs/`.
 *
 * Rounded to whole numbers: the point is "3,400 frames a minute or 40", and a decimal place
 * would only make two runs look more different than they are.
 */
export function workloadMarkdown(snapshot: WorkloadSnapshot, notes: Record<string, string>): string {
  const lines: string[] = ['## Ride workload', '']
  for (const [key, value] of Object.entries(notes)) lines.push(`- **${key}:** ${value}`)
  lines.push('')
  lines.push(
    snapshot.riding
      ? `Riding, ${Math.round(snapshot.elapsedS)} s in.`
      : `Not riding. Totals cover ${Math.round(snapshot.elapsedS)} s since the app or the last ride started.`,
  )
  lines.push('')
  lines.push(`| counter | per min (last ${WINDOW_S} s) | total |`)
  lines.push('|---|---|---|')
  for (const c of COUNTERS) {
    lines.push(`| ${COUNTER_LABELS[c]} | ${Math.round(snapshot.perMinute[c])} | ${snapshot.totals[c]} |`)
  }
  if (snapshot.lastRide) {
    const ride = snapshot.lastRide
    lines.push('')
    lines.push(`### Last ride, ${Math.round(ride.durationS)} s`)
    lines.push('')
    lines.push('| counter | per min (whole ride) | total |')
    lines.push('|---|---|---|')
    for (const c of COUNTERS) {
      lines.push(`| ${COUNTER_LABELS[c]} | ${Math.round(ride.perMinute[c])} | ${ride.totals[c]} |`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
const meter = new Meter(clock())

/** The app's one meter. Every call reads the clock itself, so a call site is one line. */
export const workload = {
  count: (counter: Counter) => meter.count(counter, clock()),
  startRide: () => meter.startRide(clock()),
  endRide: () => meter.endRide(clock()),
  snapshot: () => meter.snapshot(clock()),
}

if (typeof window !== 'undefined') {
  ;(window as unknown as { freeWheelWorkload: typeof workload }).freeWheelWorkload = workload
}
