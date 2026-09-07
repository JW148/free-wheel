import { elevationAt, type RouteGeometry } from './progress'

/**
 * The climbs and descents on a route, as things with a start, a length and a severity.
 *
 * A total ascent figure answers the wrong question. 400 m of climbing spread over 60 km is a
 * pleasant afternoon; the same 400 m in two walls is a different ride entirely, and the number
 * is identical. What a rider on the road actually wants to know is "what is the next hard bit,
 * how far away is it, and how long does it last" — and the corollary the user put better than
 * we would: whether there is a break coming on the downhill.
 *
 * Everything here is derived from BRouter's own `<ele>` values, so it works offline and needs
 * no extra data. It is also only as good as SRTM: metre-scale vertical noise on a ~30 m grid.
 * That noise is the reason for every constant below — without smoothing, a flat canal towpath
 * decomposes into two hundred "climbs".
 */

export type GradientKind = 'climb' | 'descent'

/** How hard a climb is, on the scale a rider actually thinks in. */
export type Severity = 'easy' | 'moderate' | 'hard' | 'brutal'

export interface Gradient {
  kind: GradientKind
  startM: number
  endM: number
  lengthM: number
  /** Metres gained (a climb) or lost (a descent). Always positive. */
  gainM: number
  /** Average gradient as a ratio — 0.06 is 6%. Always positive; `kind` carries the sign. */
  grade: number
  /** The steepest {@link STEEPEST_WINDOW_M} inside it. What the legs will remember. */
  maxGrade: number
  severity: Severity
}

/**
 * Distance between resampled points.
 *
 * BRouter's track points are spaced by geometry — dense at a junction, sparse on a straight —
 * so anything measured per point is measured over a varying and unknown distance. Resampling
 * onto an even grid makes "smooth over 125 m" and "the steepest 100 m" mean what they say.
 * 25 m is below SRTM's own ~30 m sample spacing, so it costs nothing in fidelity.
 */
const SAMPLE_M = 25

/** Half-width of the smoothing window, in samples. 2 either side is ±50 m. */
const SMOOTH_HALF = 2

/**
 * Height change below which a reversal is noise rather than a feature.
 *
 * The merge pass repeatedly absorbs the smallest run until nothing smaller than this is left,
 * so a climb interrupted by a 4 m dip stays one climb rather than becoming three features.
 * Set at 8 m: SRTM's stated vertical accuracy is around 6 m, so anything under this cannot be
 * distinguished from the data being wrong.
 */
const NOISE_M = 8

/** Below these a feature is real but not worth a rider's attention. */
const MIN_GAIN_M = 12
const MIN_LENGTH_M = 150
const MIN_GRADE = 0.015

const STEEPEST_WINDOW_M = 100

/**
 * The longest a single feature may be, and how many times the extraction may recurse.
 *
 * Both are there to bound the work: {@link bestSpan} is quadratic in the length of the run it
 * searches, and capping the span turns that into linear-times-a-constant. 10 km also happens
 * to be about the longest thing a rider would call "a climb" — an alpine pass split in two is
 * a fair description; a 60 km valley drag reported as one climb is not.
 */
const MAX_FEATURE_M = 10_000
const MAX_DEPTH = 5

/**
 * Finds every climb and descent worth naming.
 *
 * Three passes, and the middle one is where the work is:
 *
 * 1. **Resample and smooth** onto an even grid, killing the sampling noise.
 * 2. **Merge** — split into maximal up and down runs, then repeatedly absorb the smallest
 *    run into its neighbours until none is smaller than {@link NOISE_M}. A threshold applied
 *    per-step instead would break a climb at every false flat; absorbing smallest-first means
 *    the features that survive are the ones that are large *relative to everything around
 *    them*, which is what "a climb" means.
 * 3. **Extract** the best-scoring stretch inside each run, then recurse either side of it.
 *    See {@link bestSpan} — this is the step that stops a sharp ramp disappearing into the
 *    long shallow drag containing it.
 */
export function gradients(geometry: RouteGeometry): Gradient[] {
  if (geometry.totalM < MIN_LENGTH_M) return []

  const count = Math.max(2, Math.round(geometry.totalM / SAMPLE_M) + 1)
  const step = geometry.totalM / (count - 1)
  const raw = new Array<number>(count)
  for (let i = 0; i < count; i++) raw[i] = elevationAt(geometry, i * step)

  const elevation = smooth(raw, SMOOTH_HALF)
  const found: Gradient[] = []
  for (const run of mergeNoise(monotonicRuns(elevation), elevation)) {
    extract(elevation, run, step, found, 0)
  }
  return found.sort((a, b) => a.startM - b.startM)
}

/** Takes the best feature out of a run, then looks either side of it for more. */
function extract(
  elevation: number[],
  run: Run,
  step: number,
  found: Gradient[],
  depth: number,
): void {
  if (depth > MAX_DEPTH || run.end - run.start < 1) return

  const best = bestSpan(elevation, run, step)
  if (!best) return

  const gainM = Math.abs(elevation[best.end] - elevation[best.start])
  const lengthM = (best.end - best.start) * step
  const grade = lengthM === 0 ? 0 : gainM / lengthM
  // Nothing inside this run clears the bar. Recursing would only find weaker things.
  if (gainM < MIN_GAIN_M || lengthM < MIN_LENGTH_M || grade < MIN_GRADE) return

  found.push({
    kind: elevation[best.end] > elevation[best.start] ? 'climb' : 'descent',
    startM: best.start * step,
    endM: best.end * step,
    lengthM,
    gainM,
    grade,
    maxGrade: steepest(elevation, best.start, best.end, step),
    severity: severityOf(gainM, grade),
  })

  extract(elevation, { start: run.start, end: best.start }, step, found, depth + 1)
  extract(elevation, { start: best.end, end: run.end }, step, found, depth + 1)
}

/**
 * The stretch of a run that most deserves to be called a climb, by `gain² / length`.
 *
 * The score needs one property above all: for a constant gradient it must prefer the *whole*
 * thing, so a steady 4% climb is reported once rather than chopped up. `gain²/length` reduces
 * to `grade² × length` there, which grows with length — so it does. Two other candidates fail
 * that test outright: plain gain always takes the whole run including its flat approach, and
 * plain gradient always takes the two steepest adjacent samples.
 *
 * What it *does* split is the case that broke the previous version. On London to Brighton the
 * merge pass produced one run rising 115 m over 9.8 km — 1.2% overall, below the threshold, so
 * nothing was reported at all — with a 62 m ramp at 6% buried inside it. `gain²/length` scores
 * that ramp at 3.8 against the whole run's 2.0 and pulls it out. The shallow remainder either
 * side then falls below the threshold on its own terms, which is the right answer: it is a
 * drag, and the ramp is the climb.
 *
 * Zero-gain and wrong-signed spans are skipped rather than scored, so a dip inside a climb can
 * never be returned as the climb.
 */
function bestSpan(elevation: number[], run: Run, step: number): Run | null {
  const rising = elevation[run.end] >= elevation[run.start]
  const maxSpan = Math.max(1, Math.ceil(MAX_FEATURE_M / step))

  let best: Run | null = null
  let bestScore = 0
  for (let i = run.start; i < run.end; i++) {
    const limit = Math.min(run.end, i + maxSpan)
    for (let j = i + 1; j <= limit; j++) {
      const delta = elevation[j] - elevation[i]
      if (rising ? delta <= 0 : delta >= 0) continue
      const score = (delta * delta) / ((j - i) * step)
      if (score > bestScore) {
        bestScore = score
        best = { start: i, end: j }
      }
    }
  }
  return best
}

/**
 * How hard, from the two numbers that decide it.
 *
 * `gain × grade` rather than either alone, because neither alone ranks anything sensibly:
 * gain calls a 200 m drag up a 2% valley road harder than a 60 m wall at 12%, and grade calls
 * a 15 m ramp over a bridge harder than an alpine pass. The product is proportional to
 * gain²/length, which is the shape most climb-rating schemes converge on.
 *
 * The boundaries are in "gain metres × grade percent": 150 is roughly 50 m at 3%, 500 is
 * roughly 80 m at 6%, and 1200 is roughly 150 m at 8% — a climb most riders would get out of
 * the saddle for.
 */
export function severityOf(gainM: number, grade: number): Severity {
  const score = gainM * grade * 100
  if (score < 150) return 'easy'
  if (score < 500) return 'moderate'
  if (score < 1200) return 'hard'
  return 'brutal'
}

/** Where the rider stands in relation to the next thing worth knowing about. */
export interface GradientAhead {
  gradient: Gradient
  /** Metres until it starts. Zero once the rider is on it. */
  distanceToM: number
  /** True once the rider is inside it. */
  inIt: boolean
  /** Metres of it still to come, and the height still to gain or lose. */
  remainingM: number
  remainingGainM: number
}

/**
 * The climb or descent the rider is on, or the next one coming.
 *
 * `kind` filters, because the two answer different questions and the ride screen asks them
 * separately: "what is the next hard bit" and "when do I get a rest".
 */
export function nextGradient(
  found: Gradient[],
  alongM: number,
  kind?: GradientKind,
): GradientAhead | null {
  for (const gradient of found) {
    if (kind && gradient.kind !== kind) continue
    if (gradient.endM <= alongM) continue
    const inIt = alongM >= gradient.startM
    const remainingM = gradient.endM - Math.max(alongM, gradient.startM)
    return {
      gradient,
      distanceToM: Math.max(0, gradient.startM - alongM),
      inIt,
      remainingM,
      // Assumes the remaining height is spread evenly over the remaining distance. Within one
      // climb that is close enough, and the alternative — re-integrating the profile per fix —
      // buys precision the rider cannot act on.
      remainingGainM: gradient.lengthM === 0 ? 0 : (remainingM / gradient.lengthM) * gradient.gainM,
    }
  }
  return null
}

/** A centred moving average. The ends shrink the window rather than clamping or padding. */
function smooth(values: number[], half: number): number[] {
  const out = new Array<number>(values.length)
  for (let i = 0; i < values.length; i++) {
    const from = Math.max(0, i - half)
    const to = Math.min(values.length - 1, i + half)
    let total = 0
    for (let j = from; j <= to; j++) total += values[j]
    out[i] = total / (to - from + 1)
  }
  return out
}

interface Run {
  start: number
  end: number
}

/** Maximal runs of non-falling and non-rising values. Flat steps join the run they follow. */
function monotonicRuns(elevation: number[]): Run[] {
  const runs: Run[] = []
  let start = 0
  let rising: boolean | null = null

  for (let i = 1; i < elevation.length; i++) {
    const delta = elevation[i] - elevation[i - 1]
    if (delta === 0) continue
    const nowRising = delta > 0
    if (rising === null) {
      rising = nowRising
    } else if (nowRising !== rising) {
      runs.push({ start, end: i - 1 })
      start = i - 1
      rising = nowRising
    }
  }
  runs.push({ start, end: elevation.length - 1 })
  return runs.filter((run) => run.end > run.start)
}

/**
 * Absorbs runs smaller than {@link NOISE_M} into their neighbours, smallest first.
 *
 * Absorbing a run merges it with *both* neighbours, because removing a 3 m dip between two
 * climbs leaves one climb, not two touching ones. At the ends there is only one neighbour to
 * merge into. The loop terminates because each pass strictly reduces the number of runs.
 */
function mergeNoise(runs: Run[], elevation: number[]): Run[] {
  const working = runs.map((run) => ({ ...run }))
  const magnitude = (run: Run) => Math.abs(elevation[run.end] - elevation[run.start])

  while (working.length > 1) {
    let smallest = 0
    for (let i = 1; i < working.length; i++) {
      if (magnitude(working[i]) < magnitude(working[smallest])) smallest = i
    }
    if (magnitude(working[smallest]) >= NOISE_M) break

    const from = Math.max(0, smallest - 1)
    const to = Math.min(working.length - 1, smallest + 1)
    working.splice(from, to - from + 1, { start: working[from].start, end: working[to].end })
  }
  return working
}

/** The steepest {@link STEEPEST_WINDOW_M} inside a run, as a positive ratio. */
function steepest(elevation: number[], start: number, end: number, step: number): number {
  const span = Math.max(1, Math.round(STEEPEST_WINDOW_M / step))
  // A run shorter than the window has one gradient, and it is its own average.
  if (end - start <= span) {
    const length = (end - start) * step
    return length === 0 ? 0 : Math.abs(elevation[end] - elevation[start]) / length
  }
  let worst = 0
  for (let i = start; i + span <= end; i++) {
    worst = Math.max(worst, Math.abs(elevation[i + span] - elevation[i]) / (span * step))
  }
  return worst
}
