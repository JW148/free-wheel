import type { DataManifest, InstalledRegion, RegionEntry } from '../data/manifest'
import { formatMegabytes, type RegionSummary } from './pickerModel'

/**
 * What the Maps library says about the regions a phone already holds.
 *
 * Separate from `pickerModel.ts`, which is about *choosing* a region: the questions here are
 * the ones you only have once something is downloaded — how much room it is taking, what
 * deleting it would actually give back, whether it is out of date, and which of them you are
 * standing in.
 *
 * Pure, for the usual reason. The storage arithmetic is the part that can quietly lie, and a
 * number a rider is deciding a 400 MB deletion on had better be checked.
 */

/**
 * Bytes this phone is using for regions, counting shared road data once.
 *
 * The sharing is not a detail. The published regions are cut to fit BRouter's 5° grid, and the
 * fourteen of them between them use five cells — `W5_N50` alone is most of England and Wales.
 * Adding the regions' advertised sizes together would report roughly twice what is on the disk
 * and make the library's own total disagree with the phone's storage settings.
 */
export function storageTotal(manifest: DataManifest, installed: InstalledRegion[]): number {
  const byId = new Map(manifest.regions.map((region) => [region.id, region]))
  let bytes = 0
  for (const record of installed) bytes += byId.get(record.id)?.basemap.bytes ?? 0
  for (const name of uniqueSegments(installed)) bytes += manifest.segments[name]?.bytes ?? 0
  return bytes
}

/** Every segment any installed region needs, each named once. */
function uniqueSegments(installed: InstalledRegion[]): string[] {
  return [...new Set(installed.flatMap((record) => Object.keys(record.segmentHashes)))]
}

/**
 * What removing one region would actually free.
 *
 * The map always goes; the road data only goes if no region that is staying still wants it. A
 * rider deleting Yorkshire to make room, told they would get 200 MB back and then given 90,
 * has been lied to by arithmetic — so the shared half is worked out rather than assumed.
 *
 * This mirrors the rule in `regionStore.recordsAfterRemoval`, which is what actually deletes
 * the files. Kept separate rather than imported because that module reaches for OPFS and this
 * one runs on the main thread; the pair are held together by
 * `libraryModel.test.ts` asserting the shared-segment case the deletion path is built on.
 */
export function freedBy(
  manifest: DataManifest,
  installed: InstalledRegion[],
  id: string,
): number {
  const going = installed.find((record) => record.id === id)
  if (!going) return 0
  const staying = installed.filter((record) => record.id !== id)
  const stillNeeded = new Set(uniqueSegments(staying))
  let bytes = manifest.regions.find((region) => region.id === id)?.basemap.bytes ?? 0
  for (const name of Object.keys(going.segmentHashes)) {
    if (!stillNeeded.has(name)) bytes += manifest.segments[name]?.bytes ?? 0
  }
  return bytes
}

/**
 * The sentence under "Remove", which names the number and the consequence.
 *
 * The consequence is the important half and it is easy to leave out: a region is not a map you
 * can no longer look at, it is an area you can no longer *route in*. Riders who have used the
 * app offline know that; riders deleting something to make room for a holiday have not thought
 * about it yet.
 */
export function removalPrice(bytes: number): string {
  return bytes > 0
    ? `Frees ${formatMegabytes(bytes)}. You will not be able to plan or follow routes here until you download it again.`
    : 'You will not be able to plan or follow routes here until you download it again.'
}

/** When a region arrived, as a rider reads it. `null` for one that is not installed. */
export function installedOn(installed: InstalledRegion | undefined): string | null {
  if (!installed) return null
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long' }).format(
    new Date(installed.installedAt),
  )
}

/** Regions with something to fetch that is not a first download — the Update All candidates. */
export function updatable(summaries: RegionSummary[]): RegionSummary[] {
  return summaries.filter(
    (summary) =>
      summary.bytes > 0 &&
      (summary.state === 'road-data-outdated' || summary.state === 'map-outdated'),
  )
}

/**
 * Whether a point falls inside a region's box.
 *
 * The boxes overlap by design, so this answers a list rather than a region: standing in
 * Sheffield puts a rider in both Yorkshire and the Midlands, and pretending otherwise would be
 * the app choosing for them.
 */
export function regionsAt(regions: RegionEntry[], lon: number, lat: number): string[] {
  return regions
    .filter((region) => {
      const [west, south, east, north] = region.bbox
      return lon >= west && lon <= east && lat >= south && lat <= north
    })
    .map((region) => region.id)
}

/**
 * The browse list, with the regions a rider is standing in at the top.
 *
 * This is the whole of "near you": no distance ranking, no sorting the rest of the country by
 * how far away it is. A rider opening this screen is either downloading where they are — in
 * which case one tap should be enough — or planning a trip somewhere they will find by name.
 * Ordering Cornwall above Kent because Cornwall is marginally nearer helps nobody and moves
 * rows around under a finger.
 */
export function withNearestFirst(summaries: RegionSummary[], here: string[]): RegionSummary[] {
  if (here.length === 0) return summaries
  const near = summaries.filter((summary) => here.includes(summary.id))
  return [...near, ...summaries.filter((summary) => !here.includes(summary.id))]
}

/** The library's footer: how many regions, and how much room they take. */
export function storageLine(count: number, bytes: number): string {
  if (count === 0) return 'Nothing downloaded yet.'
  const regions = count === 1 ? '1 region' : `${count} regions`
  return `${regions} · ${formatMegabytes(bytes)}. Neighbouring regions share their road data, so the total is less than the sizes added up.`
}
