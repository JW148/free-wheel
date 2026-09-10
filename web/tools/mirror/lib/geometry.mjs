/**
 * BRouter segment names for a bounding box.
 *
 * Deliberately a second implementation of the geometry in `src/engine/tiles.ts` rather than
 * an import: this file runs under plain Node on the VPS with no TypeScript toolchain. The
 * test asserts the two agree, which is what stops them drifting.
 */
const TILE_DEGREES = 5

const originOf = (degrees) => Math.floor(degrees / TILE_DEGREES) * TILE_DEGREES

const name = (lon, lat) => {
  const ew = lon < 0 ? `W${-lon}` : `E${lon}`
  const ns = lat < 0 ? `S${-lat}` : `N${lat}`
  return `${ew}_${ns}`
}

export function segmentsForBbox([west, south, east, north]) {
  const names = new Set()
  for (let lon = originOf(west); lon < east; lon += TILE_DEGREES) {
    for (let lat = originOf(south); lat < north; lat += TILE_DEGREES) {
      names.add(name(lon, Math.min(lat, 80)))
    }
  }
  return [...names].sort()
}
