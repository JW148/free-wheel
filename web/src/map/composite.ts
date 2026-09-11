import type { Map as MapLibreMap } from 'maplibre-gl'
import {
  archiveLayers,
  archiveSource,
  basemapRoles,
  layerArchive,
  layerRole,
  sourceIdFor,
  type MapTheme,
  type PathMode,
} from './style'

/**
 * Adding and removing one archive on a map that is already on screen.
 *
 * A download finishing used to mean rebuilding the map around the new archive. That was
 * defensible when a phone held exactly one, and it is not now: a region downloaded in the
 * background while the rider is following a route would take the route line, the position dot
 * and every waypoint marker down with it, mid-ride, because `setStyle` and a fresh `Map` both
 * discard everything the ride screen has drawn. So new territory is *spliced in* instead.
 *
 * ## The ordering is the whole problem
 *
 * Layers are ranked by **role** — `earth`, then the land tiers, then `water`, and so on, the
 * order `basemapRoles()` returns — and a new archive's layers each go in at their role's
 * position rather than on top. Appending them would put the new region's land fills above its
 * neighbour's roads, and because the published regions overlap by design there is a band
 * along every shared edge where that is visible: streets that stop at a line running across
 * the map.
 *
 * Layers that belong to no basemap archive — the route line, the position dot, the region
 * outlines — rank *after* everything here, which is what makes "insert the last role" resolve
 * to "immediately before the route line" without this module having to know those layers
 * exist.
 */

/**
 * Where a layer of `role` goes, given the ids currently on the map, or `undefined` for the end.
 *
 * Pure, and separated from the MapLibre call for the usual reason: this is the part that can
 * be wrong, and a wrong answer here shows up as a rendering artefact on a device rather than
 * as an error anywhere.
 *
 * Anything whose role is not a basemap role ranks last — including the route and position
 * layers, which must stay above the map, and any layer a future screen adds. An unknown role
 * is therefore never something a basemap layer is inserted *after*.
 */
export function insertionPoint(existingIds: string[], role: string, roles: string[]): string | undefined {
  const rank = (id: string): number => {
    const index = roles.indexOf(layerRole(id))
    return index === -1 ? Number.POSITIVE_INFINITY : index
  }
  const target = roles.indexOf(role)
  if (target === -1) return undefined
  return existingIds.find((id) => rank(id) > target)
}

/**
 * Puts one archive on a map that is already built.
 *
 * Idempotent: a second call for an archive already mounted does nothing, which matters because
 * the effect that drives this re-runs whenever the installed set changes for any reason.
 *
 * Returns whether anything was added, so a caller can tell "already there" from "just arrived"
 * without asking the map.
 */
export function addArchiveToMap(
  map: MapLibreMap,
  archive: string,
  theme: MapTheme,
  paths: PathMode,
): boolean {
  const source = sourceIdFor(archive)
  if (map.getSource(source)) return false

  map.addSource(source, archiveSource(archive))

  const roles = basemapRoles()
  for (const layer of archiveLayers(archive, theme, paths)) {
    // Re-read every time rather than once before the loop: each insert changes the list, and a
    // stale snapshot would send this archive's later roles in ahead of its own earlier ones.
    const ids = map.getStyle().layers.map((existing) => existing.id)
    map.addLayer(layer, insertionPoint(ids, layerRole(layer.id), roles))
  }
  return true
}

/**
 * Takes one archive back off, layers before source.
 *
 * That order is not a style preference — MapLibre refuses to remove a source that a layer
 * still references, and the throw arrives as an exception in the middle of a delete the rider
 * has already been told succeeded.
 */
export function removeArchiveFromMap(map: MapLibreMap, archive: string): void {
  for (const layer of map.getStyle().layers) {
    if (layerArchive(layer.id) === archive) map.removeLayer(layer.id)
  }
  const source = sourceIdFor(archive)
  if (map.getSource(source)) map.removeSource(source)
}

/** Every archive a map currently draws, in the order their layers first appear. */
export function mountedArchives(map: MapLibreMap): string[] {
  const seen: string[] = []
  for (const layer of map.getStyle().layers) {
    const archive = layerArchive(layer.id)
    if (archive !== null && !seen.includes(archive)) seen.push(archive)
  }
  return seen
}
