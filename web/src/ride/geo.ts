/** Great-circle distance in metres between two `[lon, lat]` points. */
export function haversineM(a: [number, number], b: [number, number]): number {
  const R = 6_371_000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b[1] - a[1])
  const dLon = toRad(b[0] - a[0])
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/**
 * The smaller of the two ways round between two bearings, in degrees. Always 0–180.
 *
 * Bearings are on a circle, so plain subtraction says 350° and 10° are 340° apart when they
 * are 20°. Every comparison of two headings in this app needs this and none of them may use
 * `Math.abs(a - b)`.
 */
export function angleGap(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180)
}
