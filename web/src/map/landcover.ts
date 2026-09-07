/**
 * The land-cover taxonomy: how Protomaps' 43 `landuse` kinds become the handful of surfaces a
 * cyclist actually needs to tell apart, and in what order they are painted.
 *
 * ## Why this exists at all
 *
 * The archive already carries everything needed to make the map legible. The old style threw
 * it away: one `fill-color` for the whole `landuse` layer, so farmland, forest, a school
 * playing field and an industrial estate all arrived as the same grey-green wash. Measured
 * against the light theme's building colour, that wash sat at **ΔE 2.8** — below the
 * just-noticeable difference. The map was not under-designed, it was under-*read*.
 *
 * ## Why tiers instead of one data-driven layer
 *
 * The obvious shape is a single `fill` layer with a `match` on `kind`, the way `paths` handles
 * dash patterns. It does not work here, because landuse polygons **overlap constantly** — a
 * park inside a residential block, a pitch inside the park, a garden inside a terrace.
 *
 * Within one layer MapLibre paints features in the order the tile happens to list them, and
 * Protomaps stamps `sort_rank` **189 on every single landuse feature**, so there is no
 * ordering signal to sort by. A park would sometimes land under the residential polygon
 * containing it and simply disappear.
 *
 * The old style dodged this with `fill-opacity: 0.5`, which is why it looked washed out:
 * translucency made the ordering *not matter* by blending everything. It also meant a colour
 * at every overlap that nobody chose — the same trap `docs/phase-4-progress.md` records for
 * stacked route fills.
 *
 * So: opaque fills, in explicit tiers, most-specific on top. Draw order becomes a property of
 * the layer list, which is something we control and can test.
 */

/**
 * A surface a rider needs to distinguish. Deliberately coarser than Protomaps' 43 kinds —
 * `college` and `kindergarten` are the same thing when you are trying to work out where you
 * are.
 */
export type LandClass =
  // Built and neutral surfaces.
  | 'residential'
  | 'industrial'
  | 'institution'
  | 'pedestrian'
  | 'military'
  | 'aeroway'
  | 'other'
  // Open ground that is not green.
  | 'farm'
  | 'bare'
  | 'glacier'
  | 'scrub'
  | 'wetland'
  // Private green.
  | 'garden'
  // Green.
  | 'wood'
  | 'grass'
  | 'cemetery'
  // Green you can use, and the landmarks.
  | 'park'
  | 'sport'

/**
 * Kind to class. Covers both the `landuse` and `landcover` source-layers, because they use
 * different vocabularies for the same ground and the two views should agree about what green
 * means where they meet at z7.
 *
 * A deliberate mapping rather than a heuristic: it is asserted complete against the kinds the
 * real archive produces, so a kind added by a future schema version shows up as a test
 * failure rather than a polygon in the fallback colour.
 */
const LAND_CLASS: Readonly<Record<string, LandClass>> = {
  // ── Built ────────────────────────────────────────────────────────────────────────────────
  residential: 'residential',
  // `urban_area` is `landcover`'s only built-up signal, and at z3-z7 it is the *only* thing
  // distinguishing a city from a field.
  urban_area: 'residential',
  industrial: 'industrial',
  commercial: 'industrial',
  retail: 'industrial',
  railway: 'industrial',
  platform: 'industrial',
  school: 'institution',
  university: 'institution',
  college: 'institution',
  kindergarten: 'institution',
  hospital: 'institution',
  pedestrian: 'pedestrian',
  military: 'military',
  aerodrome: 'aeroway',
  airfield: 'aeroway',
  runway: 'aeroway',
  // Neither built nor natural, and too rare to earn a colour: a dam, a pier, and Protomaps'
  // own catch-all. A near-neutral keeps them from asserting anything they should not.
  other: 'other',
  dam: 'other',
  pier: 'other',

  // ── Open, not green ──────────────────────────────────────────────────────────────────────
  farmland: 'farm',
  farmyard: 'farm',
  orchard: 'farm',
  vineyard: 'farm',
  bare_rock: 'bare',
  scree: 'bare',
  sand: 'bare',
  beach: 'bare',
  barren: 'bare',
  // Its own class rather than folded into `bare`: sand-coloured ice would be actively
  // misleading anywhere alpine, and the tile importer is not Edinburgh-only.
  glacier: 'glacier',
  scrub: 'scrub',
  heath: 'scrub',
  wetland: 'wetland',
  marsh: 'wetland',

  // ── Private green ────────────────────────────────────────────────────────────────────────
  // The most common kind in the archive, and not a park. See `landcover.test.ts`.
  garden: 'garden',

  // ── Green ────────────────────────────────────────────────────────────────────────────────
  wood: 'wood',
  forest: 'wood',
  grass: 'grass',
  grassland: 'grass',
  meadow: 'grass',
  village_green: 'grass',
  cemetery: 'cemetery',

  // ── Green you can use ────────────────────────────────────────────────────────────────────
  park: 'park',
  recreation_ground: 'park',
  nature_reserve: 'park',
  national_park: 'park',
  dog_park: 'park',
  golf_course: 'park',
  allotments: 'park',
  // Reads as parkland from above and is a genuine landmark, which is what this tone is for.
  zoo: 'park',
  pitch: 'sport',
  playground: 'sport',
}

/** The class for a Protomaps `kind`, or `undefined` if the taxonomy has not seen it. */
export function classify(kind: string): LandClass | undefined {
  return LAND_CLASS[kind]
}

/** Every kind the taxonomy knows, for building style filters. */
export function kindsFor(cls: LandClass): string[] {
  return Object.keys(LAND_CLASS).filter((kind) => LAND_CLASS[kind] === cls)
}

/**
 * The `landcover` source-layer's entire vocabulary — six kinds, against `landuse`'s 43.
 *
 * Harvested by decoding real tiles: `landcover` returns features only at **z3-z7**, and
 * nothing at all from z8 up, where `landuse` takes over. Both are styled, because between
 * them they cover every zoom the app can reach.
 *
 * This list exists so a tier holding none of these kinds does not get a `landcover` layer it
 * could never fill. Asserted against the archive in `landcover.test.ts`.
 */
export const LANDCOVER_KINDS: readonly string[] = [
  'barren',
  'farmland',
  'forest',
  'glacier',
  'grassland',
  'urban_area',
]

export interface LandTier {
  /** Layer id. Prefixed `land-` so the whole group is easy to find and filter. */
  readonly id: string
  readonly classes: readonly LandClass[]
}

/**
 * Draw order, bottom to top. Later tiers paint over earlier ones.
 *
 * The ordering rule is *specificity*: a park inside a residential block is the more precise
 * statement about that ground, so it wins. `sport` sits above `park` because a pitch is
 * usually inside one, and `garden` sits below the real greenery so a back garden can never
 * obscure a park it happens to touch.
 */
export const LAND_TIERS: readonly LandTier[] = [
  {
    id: 'land-built',
    classes: ['residential', 'industrial', 'aeroway', 'institution', 'pedestrian', 'military', 'other'],
  },
  { id: 'land-open', classes: ['farm', 'bare', 'glacier', 'scrub', 'wetland'] },
  { id: 'land-garden', classes: ['garden'] },
  { id: 'land-green', classes: ['wood', 'grass', 'cemetery'] },
  { id: 'land-park', classes: ['park', 'sport'] },
]
