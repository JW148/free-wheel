/**
 * BRouter segment names for a bounding box.
 *
 * Deliberately a second implementation of the geometry in `src/engine/tiles.ts` rather than
 * an import: this file runs under plain Node on the VPS with no TypeScript toolchain. The
 * test asserts the two agree, which is what stops them drifting. The guards and antimeridian
 * handling mirror `tiles.ts` deliberately.
 */
const TILE_DEGREES = 5

const originOf = (degrees) => Math.floor(degrees / TILE_DEGREES) * TILE_DEGREES

const name = (lon, lat) => {
  const ew = lon < 0 ? `W${-lon}` : `E${lon}`
  const ns = lat < 0 ? `S${-lat}` : `N${lat}`
  return `${ew}_${ns}`
}

export function segmentsForBbox([west, south, east, north]) {
  // Handle antimeridian crossing: split into two spans if west > east
  const spans = west <= east ? [[west, east]] : [[west, 180], [-180, east]]

  const names = new Set()
  for (const [spanWest, spanEast] of spans) {
    for (let lon = originOf(spanWest); lon < spanEast; lon += TILE_DEGREES) {
      for (let lat = originOf(south); lat < north; lat += TILE_DEGREES) {
        // Skip tiles outside the valid BRouter grid
        if (lat < -90 || lat > 80 || lon < -180 || lon > 175) continue
        names.add(name(lon, lat))
      }
    }
  }
  return [...names].sort()
}
