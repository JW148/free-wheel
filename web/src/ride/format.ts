/**
 * Numbers as a rider reads them at 25 km/h, one-handed, in the rain.
 *
 * Kept apart from `gpx.ts` — which formats distance and duration only because it already
 * parses them — because everything here exists for the *riding* screen, where the constraints
 * are different. A glance is under a second, so no unit is repeated that a label already
 * carries, nothing is quoted to a precision the underlying measurement does not support, and
 * a figure that is not known says so rather than showing a plausible zero.
 */

/** `14:32`. The most useful thing an ETA can say, because it is comparable to a clock. */
export function formatClock(at: number | null): string {
  if (at === null) return '—'
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/**
 * `4:12` / `1:07:20`. Elapsed time, in the shape a stopwatch shows.
 *
 * Deliberately different from `formatDuration`'s "1h 07m": that reads an *estimate*, which is
 * approximate and wants words. This reads a running clock, which is exact and wants colons.
 */
export function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`
}

/** `24.3`, with no unit — the label next to it says km/h. `—` when there is no fix to ask. */
export function formatSpeed(metresPerSecond: number | null): string {
  if (metresPerSecond === null || !Number.isFinite(metresPerSecond)) return '—'
  return (Math.max(0, metresPerSecond) * 3.6).toFixed(1)
}

/**
 * `220`, to the nearest five watts.
 *
 * The estimate is not accurate to one watt and rounding to one implies it is. Five is also
 * enough quantisation to stop the last digit flickering between fixes, which is what makes an
 * unrounded readout unreadable on a moving bike.
 */
export function formatPower(watts: number | null): string {
  if (watts === null || !Number.isFinite(watts)) return '—'
  return String(Math.round(watts / 5) * 5)
}

/**
 * `450 m` / `1.2 km` / `12 km` — distance *to* something.
 *
 * Different from `formatDistance` on purpose. That one always gives a decimal above a
 * kilometre, which is right for a route length you are comparing. This is a countdown: at
 * 12 km away the tenth is noise, at 450 m the rider wants the actual number, and below 100 m
 * it rounds to ten so it does not tick every stride.
 */
export function formatAway(metres: number): string {
  if (metres < 100) return `${Math.round(metres / 10) * 10} m`
  if (metres < 1000) return `${Math.round(metres / 50) * 50} m`
  if (metres < 10_000) return `${(metres / 1000).toFixed(1)} km`
  return `${Math.round(metres / 1000)} km`
}

/** `1.4 MJ` is meaningless to a cyclist; `340 kJ` is the number on every head unit. */
export function formatEnergy(kilojoules: number): string {
  return `${Math.round(kilojoules)}`
}
