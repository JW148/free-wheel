import type {
  ExpressionSpecification,
  FillLayerSpecification,
  FilterSpecification,
  StyleSpecification,
} from 'maplibre-gl'
import { LAND_TIERS, LANDCOVER_KINDS, type LandClass, type LandTier, kindsFor } from './landcover'

/**
 * A minimal basemap style for the Protomaps v4 schema, with everything it needs served from
 * this origin and nothing fetched from the internet.
 *
 * ## Glyphs and sprites are the offline trap
 *
 * A PMTiles archive holds geometry and nothing else. Glyphs (SDF font atlases, one file per
 * 256-codepoint range) and sprites (the icon sheet) are **separate HTTP requests** that
 * MapLibre makes on its own. Point them at a CDN and the map renders beautifully on the desk
 * and then loses every label and icon in airplane mode — which reads as a styling bug rather
 * than a missing download.
 *
 * So they are self-hosted under `public/`, refreshed by `npm run fetch-map-assets`, and
 * precached by the service worker (`globPatterns` in `vite.config.ts` includes `pbf` and
 * `png` for exactly this reason).
 *
 * The URLs are absolute. **Glyph requests are issued from MapLibre's worker**, where a
 * relative URL would resolve against `/assets/` and quietly 404 — the same class of bug that
 * `maplibreWorker.ts` exists to fix.
 *
 * Also note this is **not** mapcn's default CARTO basemap, which is online-only and requires
 * a CARTO Enterprise licence for commercial use. Nothing here talks to a server.
 *
 * Layer names come from the archive's own metadata (`pmtiles show --metadata`), not guesswork:
 * boundaries, buildings, earth, landcover, landuse, places, pois, roads, water.
 */

export type MapTheme = 'dark' | 'light'

/** One colour per land surface. Keyed by `LandClass` so the compiler enforces completeness. */
export type PaletteLand = Record<LandClass, string>

export interface Palette {
  /**
   * The base ground, and the halo behind every label. Everything else is painted on top of
   * this, so it is the colour the whole map is judged against.
   */
  earth: string
  /** A fill, so exempt from the stroke chroma ceiling. Also used for canals and streams. */
  water: string
  building: string
  /** Land-cover fills. **Allowed above the stroke ceiling** — see `line` below. */
  land: PaletteLand
  /**
   * Every stroke in the basemap, and the one group the chroma ceiling applies to.
   *
   * The ceiling exists so that a route line cannot be mistaken for a line belonging to the
   * map. That is an argument about *lines*: a 5px vivid stroke against a 3px muted stroke is
   * a genuine confusion, while a 5px stroke against a park-sized area of pale green is not.
   * Which is why `land.park` may sit at C 23.6 and `line.pathTrack` may not.
   */
  line: {
    road: string
    roadCasing: string
    major: string
    rail: string
    /**
     * Three tones of one warm hue, not three hues. Separation between them is lightness at
     * held chroma; separation between path *kinds* is dash pattern. See the `paths` layer.
     */
    pathCycle: string
    pathTrack: string
    pathFoot: string
    boundary: string
  }
  text: {
    label: string
    labelMuted: string
    labelWater: string
    /**
     * Labels sit directly on top of map geometry, so every one gets a halo in the background
     * colour. Without it, a street name disappears wherever it crosses a park — and now that
     * parks are actually green, it would disappear more visibly than before.
     */
    halo: string
  }
}

/**
 * Two palettes, because a bike is ridden in both conditions.
 *
 * **Dark** is the default: it recedes behind the route line, it is what a phone clamped to a
 * handlebar at dusk wants, and on an OLED screen it costs noticeably less battery on a long
 * ride.
 *
 * **Light** exists because a dark map in direct sunlight is genuinely worse — glare wins and
 * the contrast collapses. That is a real trade-off rather than a matter of taste, so it is
 * one tap away rather than a rebuild.
 *
 * Neither uses pure black or pure white. Pure black crushes the road hierarchy into a single
 * smear when read at speed, and pure white blows out next to the orange route line.
 *
 * ## Why the land is coloured at all
 *
 * It was not, and that was the bug. Every one of Protomaps' 43 `landuse` kinds was painted a
 * single grey-green at 50% opacity, which measured **ΔE 2.8** against the light theme's
 * building colour — below the just-noticeable difference. Farmland, forest, a school playing
 * field and an industrial estate all arrived as the same wash, and the map became genuinely
 * hard to orient by on a ride. The data to fix it was already on the phone, unrendered.
 *
 * Every value below is chosen in CIELCh, so lightness and chroma are set independently, and
 * every constraint is asserted in `style.test.ts` rather than merely recorded here:
 *
 * - strokes stay at or under **C 15.4** (the ceiling is `pathTrack`: C 15.13 dark, 15.30
 *   light — `docs/phase-4-progress.md` quotes 15.1, which is the dark figure only);
 * - land fills go above it, up to **C 24.9**, which is the entire point;
 * - every route colour keeps **ΔE ≥ 16** from every colour here. Measured worst case is 17.15
 *   light and 17.81 dark, both `fastbike` against blue — better than the palette that
 *   shipped, whose true worst was 15.5.
 *
 * ## The warm earth is load-bearing
 *
 * Light `earth` moved from `#eef0ef` (a cool near-neutral) to `#f4f2ed`. That is not a taste
 * change: against the old cool base, blue water could reach only ΔE 15.7 before colliding
 * with the `fastbike` route line, and the whole map read faintly green once the land was
 * coloured. A warm base gives every cool and green surface room to separate — with it, water
 * clears ΔE 17.2 from both earth and the route.
 */
export const PALETTES: Record<MapTheme, Palette> = {
  dark: {
    earth: '#06141b',
    water: '#0f3f59', //     L* 24.9  C 20.8  h 254
    building: '#11212d',
    land: {
      // Built and neutral. These climb *up* from earth rather than down from white, because
      // at L* 5.6 there is nowhere below to go.
      residential: '#1a2025', // L* 11.9  C  4.5  h 254
      industrial: '#2c242e', //  L* 15.5  C  8.0  h 320
      institution: '#2f231c', // L* 14.9  C  8.2  h  57
      pedestrian: '#24211c', //  L* 12.9  C  3.9  h  85
      military: '#29261a', //    L* 15.1  C  8.5  h  97
      aeroway: '#1a1e21', //     L* 11.0  C  2.9  h 249
      other: '#201e1b', //       L* 11.4  C  2.4  h  84
      // Open ground that is not green.
      farm: '#292616', //        L* 15.0  C 11.3  h  99
      bare: '#2b251d', //        L* 15.1  C  6.5  h  79
      glacier: '#41484a', //     L* 30.0  C  3.2  h 223
      scrub: '#282c1c', //       L* 17.2  C 11.1  h 118
      wetland: '#212f25', //     L* 17.9  C  9.6  h 152
      // Private green: present and leafy, never a landmark.
      garden: '#22291d', //      L* 15.6  C  9.1  h 131
      // Green.
      wood: '#142818', //        L* 14.0  C 14.9  h 147
      grass: '#273721', //       L* 21.1  C 16.6  h 135
      cemetery: '#1f2821', //    L* 15.1  C  6.6  h 150
      // Green you can use. The brightest thing on the map that is not a route.
      park: '#293e25', //        L* 23.8  C 19.1  h 138
      sport: '#2a3321', //       L* 19.9  C 12.9  h 128
    },
    line: {
      road: '#46596a',
      roadCasing: '#06141b',
      major: '#6a8090',
      rail: '#2d363d',
      pathCycle: '#8a7a63',
      pathTrack: '#6b5c46',
      pathFoot: '#4e4436',
      boundary: '#253745',
    },
    text: {
      label: '#ccd0cf',
      labelMuted: '#9ba8ab',
      // Lifted from `#7590a3`, which sat ΔE 15.5 from the `fastbike` route colour and was the
      // worst approach anywhere in the shipped palette — labels included, which is the part
      // the figure in `profiles.ts` had missed.
      labelWater: '#8d9aa6', //  L* 62.9  C  8.1  h 255
      halo: '#06141b',
    },
  },
  light: {
    // Warm, not cool. See "The warm earth is load-bearing" above.
    earth: '#f4f2ed', //         L* 95.5  C  2.6  h  94
    water: '#b5ddf6', //         L* 86.1  C 18.1  h 245
    building: '#dfe3e2',
    land: {
      residential: '#ede9e3', // L* 92.5  C  3.4  h  85
      industrial: '#dfdbe6', //  L* 88.0  C  5.9  h 304
      institution: '#fae4d5', // L* 92.0  C 11.3  h  63
      pedestrian: '#f1ece5', //  L* 93.6  C  4.0  h  83
      military: '#e4dcc8', //    L* 87.9  C 10.8  h  93
      aeroway: '#e0e4e8', //     L* 90.4  C  2.5  h 256
      other: '#eae8e4', //       L* 92.0  C  2.2  h  91
      farm: '#f0e9c7', //        L* 92.1  C 17.7  h 100
      bare: '#ecddce', //        L* 88.9  C  9.6  h  74
      glacier: '#eef5f6', //     L* 96.1  C  2.5  h 211
      scrub: '#d4dabc', //       L* 85.9  C 15.8  h 117
      wetland: '#cadfd0', //     L* 86.9  C 11.0  h 153
      garden: '#dee9d3', //      L* 91.0  C 12.1  h 129
      wood: '#a0c8a3', //        L* 76.9  C 24.9  h 145
      grass: '#cbe4c0', //       L* 88.0  C 20.9  h 135
      cemetery: '#d5e3d8', //    L* 88.9  C  7.7  h 151
      park: '#c1e1ba', //        L* 86.4  C 23.6  h 139
      sport: '#c4d2b5', //       L* 82.5  C 16.2  h 128
    },
    line: {
      road: '#ffffff',
      roadCasing: '#c8ccca',
      major: '#f0ede4',
      rail: '#c2c7cb',
      // Inverted on the daylight map: the *darkest* tone is the most prominent, because these
      // sit against a near-white earth.
      pathCycle: '#9a8972',
      pathTrack: '#baa990',
      pathFoot: '#cfc2b0',
      boundary: '#9ba8ab',
    },
    text: {
      label: '#11212d',
      labelMuted: '#4a5c6a',
      labelWater: '#4a6b80',
      halo: '#f4f2ed',
    },
  },
}

/** Font stacks, named exactly as the directories under `public/fonts/`. */
const REGULAR = ['Noto Sans Regular']
const MEDIUM = ['Noto Sans Medium']

/**
 * Absolute origin for style assets.
 *
 * `import.meta.env.BASE_URL` rather than a hardcoded `/`, so the app survives being served
 * from a subpath. Absolute because **glyph requests are issued from MapLibre's worker**,
 * where a relative URL resolves against `/assets/` and quietly 404s.
 *
 * Resolved per call rather than at module load: reading `location` while the module
 * initialises makes the style impossible to unit test, and buys nothing — `basemapStyle`
 * only ever runs on the main thread.
 */
function assetsBase(): string {
  return new URL(import.meta.env.BASE_URL, location.href).href
}

/**
 * Only fill polygons.
 *
 * Protomaps ships linear water — canals, streams, rivers — as LineStrings in the *same*
 * source-layer as lakes and reservoirs, and MapLibre's fill bucket closes a LineString into
 * a ring and fills it. Without this guard the Union Canal is painted as a lake-sized slab
 * straight across the tile, which reads as the map being torn. `landuse` and `landcover`
 * carry linear features in other regions, so every fill layer gets it, not just water.
 */
const POLYGONS_ONLY: ExpressionSpecification = ['==', ['geometry-type'], 'Polygon']

/**
 * How much of the path network to draw.
 *
 * `rideable` is the default: the ways a bike can actually use. `all` adds the ways you would
 * have to walk, which matter when you are looking for a link between two roads and do not
 * mind carrying. `none` is for when the map is busy and you only want the streets.
 */
export type PathMode = 'rideable' | 'all' | 'none'

/**
 * The order the toggle steps through. `rideable` is the default and the useful state, so an
 * accidental tap lands on *more* information rather than a blank map.
 */
export function nextPathMode(mode: PathMode): PathMode {
  return mode === 'rideable' ? 'all' : mode === 'all' ? 'none' : 'rideable'
}

/** Ridden or pushed. `track` is a farm or forest track; `path` is Protomaps' catch-all. */
const RIDEABLE_PATHS = ['cycleway', 'track', 'path', 'bridleway']
/** Walked. Useful as a link, never as a route. */
const WALKED_PATHS = ['footway', 'pedestrian', 'steps']

/**
 * An **allowlist**, deliberately, rather than a denylist of the kinds we do not want.
 *
 * Protomaps' `roads` layer files a lot under `kind: 'path'` that is no use on a bike:
 * `sidewalk` duplicates a road you can already see, `crossing` is a few metres of paint,
 * `corridor` is *inside a building*, and `pier` goes nowhere. Decoding one z14 tile over
 * central Edinburgh finds 65 footways, 28 flights of steps and 22 pedestrian ways against 6
 * cycleways — the noise outnumbers the signal roughly ten to one, which is what made the map
 * hard to read.
 *
 * Allowlisting means a `kind_detail` added in a future schema version cannot quietly appear.
 */
export function pathFilter(mode: PathMode): FilterSpecification {
  const allowed =
    mode === 'all' ? [...RIDEABLE_PATHS, ...WALKED_PATHS] : mode === 'rideable' ? RIDEABLE_PATHS : []
  return [
    'all',
    ['==', ['get', 'kind'], 'path'],
    ['in', ['get', 'kind_detail'], ['literal', allowed]],
  ]
}

/**
 * Paths are drawn by the `paths` layer below and must not also be drawn as roads.
 *
 * `roads-casing` is the reason they used to read so heavily: it paints a dark casing up to
 * 8px wide under *everything* it matches, so a footway arrived with the same visual weight as
 * a dual carriageway. Excluding paths from the casing is most of the fix on its own.
 *
 * `rail` is excluded for a different reason: it was being drawn as a road, so a railway line
 * looked like a street you could ride down. It gets its own thin dashed layer instead.
 */
const NOT_PATHS_OR_RAIL: FilterSpecification = [
  'all',
  ['!=', ['get', 'kind'], 'path'],
  ['!=', ['get', 'kind'], 'rail'],
]

/**
 * One fill layer for one tier of land classes.
 *
 * The colour is a `match` on `kind` rather than one layer per kind, because a tier holds
 * several classes and each class holds several kinds — 43 kinds would otherwise be 43 layers.
 * The filter restricts the layer to exactly the kinds the `match` knows, so the fallback is
 * unreachable; it exists because `match` requires one.
 *
 * `sourceLayer` is either `landuse` (live from z7 up) or `landcover` (z3-z7 only, six coarse
 * kinds). Both are drawn, because between them they cover every zoom, and they share the
 * class taxonomy so the two views agree about what green means where they meet.
 */
function landLayer(
  tier: LandTier,
  colours: Palette,
  sourceLayer: string,
  idSuffix: string,
  vocabulary?: readonly string[],
): FillLayerSpecification {
  // Restricted to what the source-layer can actually produce, so a `landcover` layer does not
  // filter for `garden` — a kind that source-layer has never heard of.
  const inVocabulary = (kind: string): boolean => !vocabulary || vocabulary.includes(kind)
  const kinds = tier.classes.flatMap(kindsFor).filter(inVocabulary)

  // A single-class tier needs no expression at all, and a constant reads better in the
  // devtools style inspector than a one-branch `match`.
  // `match` takes alternating label/output pairs, where a label may itself be an array of
  // values sharing one output — which is what lets `wood` and `forest` collapse to one branch.
  // Do not `.flat()` this: it splices those label arrays open and MapLibre then reads a kind
  // name where it expects a colour ("Could not parse color from value 'farmland'").
  const branches = tier.classes
    .map((cls) => [kindsFor(cls).filter(inVocabulary), colours.land[cls]] as const)
    .filter(([labels]) => labels.length > 0)

  const fillColour: string | ExpressionSpecification =
    branches.length === 1
      ? branches[0][1]
      : ([
          'match',
          ['get', 'kind'],
          ...branches.flatMap(([labels, colour]) => [labels, colour]),
          branches[0][1],
        ] as unknown as ExpressionSpecification)

  return {
    id: `${tier.id}${idSuffix}`,
    type: 'fill',
    source: 'basemap',
    'source-layer': sourceLayer,
    filter: ['all', POLYGONS_ONLY, ['in', ['get', 'kind'], ['literal', kinds]]],
    // Opaque, deliberately. See `landcover.ts` for why translucency was the old workaround
    // and why tiers replace it.
    paint: { 'fill-color': fillColour },
  }
}

/**
 * Every land fill, bottom to top: the coarse `landcover` tiers first, then the detailed
 * `landuse` tiers over them.
 */
function landLayers(colours: Palette): FillLayerSpecification[] {
  const coarse = LAND_TIERS.filter((tier) =>
    tier.classes.some((cls) => kindsFor(cls).some((kind) => LANDCOVER_KINDS.includes(kind))),
  )
  return [
    ...coarse.map((tier) => landLayer(tier, colours, 'landcover', '-low', LANDCOVER_KINDS)),
    ...LAND_TIERS.map((tier) => landLayer(tier, colours, 'landuse', '')),
  ]
}

export function basemapStyle(
  archive: string,
  theme: MapTheme = 'dark',
  paths: PathMode = 'rideable',
): StyleSpecification {
  const ASSETS = assetsBase()
  const COLOURS = PALETTES[theme]
  return {
    version: 8,
    glyphs: `${ASSETS}fonts/{fontstack}/{range}.pbf`,
    sprite: `${ASSETS}sprites/light`,
    sources: {
      basemap: {
        type: 'vector',
        url: `pmtiles://${archive}`,
        attribution:
          '<a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap</a>',
      },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': COLOURS.earth } },
      {
        id: 'earth',
        type: 'fill',
        source: 'basemap',
        'source-layer': 'earth',
        filter: POLYGONS_ONLY,
        paint: { 'fill-color': COLOURS.earth },
      },

      // ── Land cover ──────────────────────────────────────────────────────────────────────
      // The whole point of this revision. Ten layers rather than two, because overlapping
      // landuse polygons carry no draw order of their own.
      ...landLayers(COLOURS),

      {
        id: 'water',
        type: 'fill',
        source: 'basemap',
        'source-layer': 'water',
        filter: POLYGONS_ONLY,
        paint: { 'fill-color': COLOURS.water },
      },
      // Linear water, drawn properly. Filtering the fill layer above would otherwise discard
      // every canal, stream and narrow river outright — and a canal towpath is one of the
      // better things to be riding on, so losing them would be a real loss rather than a
      // cosmetic one.
      //
      // These reuse the water *fill* colour rather than a darker stroke of their own. A
      // dedicated colour was tried and abandoned: at any chroma that made a canal read
      // clearly it landed ΔE 9.4 from the `fastbike` route line, which is the exact failure
      // the stroke ceiling exists to prevent. The fill colour still gives a canal ΔE 17.2
      // against earth — nearly double the 9.4 the shipped style managed.
      {
        id: 'water-lines',
        type: 'line',
        source: 'basemap',
        'source-layer': 'water',
        filter: ['==', ['geometry-type'], 'LineString'],
        paint: {
          'line-color': COLOURS.water,
          // A stream is not a canal is not a river; width by kind keeps a burn from reading
          // as something you cannot cross.
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            10,
            ['match', ['get', 'kind'], 'river', 1.6, 'canal', 1.2, 0.6],
            16,
            ['match', ['get', 'kind'], 'river', 7, 'canal', 5, 2.5],
          ],
        },
      },
      {
        id: 'buildings',
        type: 'fill',
        source: 'basemap',
        'source-layer': 'buildings',
        filter: POLYGONS_ONLY,
        minzoom: 13,
        paint: { 'fill-color': COLOURS.building },
      },
      // Casing under the fill, so roads read as lines rather than a flat wash.
      {
        id: 'roads-casing',
        type: 'line',
        source: 'basemap',
        'source-layer': 'roads',
        filter: NOT_PATHS_OR_RAIL,
        paint: {
          'line-color': COLOURS.line.roadCasing,
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.2, 16, 8],
        },
      },
      {
        id: 'roads',
        type: 'line',
        source: 'basemap',
        'source-layer': 'roads',
        filter: NOT_PATHS_OR_RAIL,
        paint: {
          'line-color': [
            'match',
            ['get', 'kind'],
            'highway',
            COLOURS.line.major,
            'major_road',
            COLOURS.line.major,
            COLOURS.line.road,
          ],
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 16, 6],
        },
      },
      // Railways, which used to be drawn as roads — so a main line looked like a street you
      // could ride down. Thin and dashed: a railway is a landmark and a barrier, never a way
      // through.
      {
        id: 'rail',
        type: 'line',
        source: 'basemap',
        'source-layer': 'roads',
        filter: ['==', ['get', 'kind'], 'rail'],
        minzoom: 11,
        paint: {
          'line-color': COLOURS.line.rail,
          'line-dasharray': [3, 2],
          'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.5, 16, 1.6],
        },
      },
      // Above the roads, so a cycleway running beside a street is not buried under it, and
      // below the labels, which still have to win.
      //
      // One layer rather than one per dash pattern: `line-dasharray` is
      // `cross-faded-data-driven` in MapLibre 6, so it takes a `match` on the feature. It is
      // *not* interpolatable, so `step`/`match` only — an `interpolate` here fails validation.
      //
      // Dash units are multiples of the line width, not pixels, so these patterns are tuned
      // for the ~2px widths below and would look quite different at the old 6px.
      {
        id: 'paths',
        type: 'line',
        source: 'basemap',
        'source-layer': 'roads',
        filter: pathFilter(paths),
        // Below z12 a path is a smear rather than information, and the network is dense
        // enough that drawing it there costs legibility for nothing. In practice Protomaps
        // stamps `min_zoom: 14` on cycleways anyway, so almost nothing exists before z14.
        minzoom: 12,
        layout: { 'line-cap': 'round' },
        paint: {
          'line-color': [
            'match',
            ['get', 'kind_detail'],
            'cycleway',
            COLOURS.line.pathCycle,
            ['track', 'path', 'bridleway'],
            COLOURS.line.pathTrack,
            COLOURS.line.pathFoot,
          ],
          // Roughly a third of the old width. A path is context for the route line, not a
          // competitor to it.
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            12,
            ['match', ['get', 'kind_detail'], 'cycleway', 0.8, 'track', 0.7, 0.6],
            16,
            ['match', ['get', 'kind_detail'], 'cycleway', 2.4, ['track', 'path', 'bridleway'], 2, 1.4],
          ],
          // `[1, 0]` is solid: `LineAtlas.addRegularDash` splices zero-length ranges out and
          // then wraps the single remaining range, so the cycleway gets an unbroken line
          // without needing a layer of its own.
          'line-dasharray': [
            'match',
            ['get', 'kind_detail'],
            'cycleway',
            ['literal', [1, 0]],
            'track',
            ['literal', [3, 1.5]],
            'bridleway',
            ['literal', [2, 2.5]],
            'steps',
            ['literal', [0.4, 0.4]],
            ['footway', 'pedestrian'],
            ['literal', [0.5, 1.5]],
            ['literal', [2, 1.5]],
          ],
        },
      },
      {
        id: 'boundaries',
        type: 'line',
        source: 'basemap',
        'source-layer': 'boundaries',
        paint: {
          'line-color': COLOURS.line.boundary,
          'line-dasharray': [2, 2],
          'line-width': 1,
        },
      },

      // ── Labels and icons ────────────────────────────────────────────────────────────────
      // Everything below needs glyphs; the POI layer also needs the sprite. Both are kept in
      // the style so that a missing asset shows up immediately rather than the first time
      // someone zooms in far enough to care.

      {
        id: 'water-labels',
        type: 'symbol',
        source: 'basemap',
        'source-layer': 'water',
        minzoom: 11,
        filter: ['has', 'name'],
        layout: {
          'text-field': ['get', 'name'],
          'text-font': REGULAR,
          'text-size': 11,
          'text-max-width': 6,
          'symbol-placement': 'line',
        },
        paint: {
          'text-color': COLOURS.text.labelWater,
          'text-halo-color': COLOURS.text.halo,
          'text-halo-width': 1.2,
        },
      },
      {
        id: 'road-labels',
        type: 'symbol',
        source: 'basemap',
        'source-layer': 'roads',
        minzoom: 14,
        filter: ['has', 'name'],
        layout: {
          'text-field': ['get', 'name'],
          'text-font': REGULAR,
          'text-size': 11,
          // Along the line, not above it: a street name only reads as a street name when it
          // follows the street.
          'symbol-placement': 'line',
          'text-rotation-alignment': 'map',
          'symbol-spacing': 300,
        },
        paint: {
          'text-color': COLOURS.text.labelMuted,
          'text-halo-color': COLOURS.text.halo,
          'text-halo-width': 1.5,
        },
      },
      {
        id: 'poi-icons',
        type: 'symbol',
        source: 'basemap',
        'source-layer': 'pois',
        minzoom: 15,
        // The sprite sheet does not have an icon for every `kind` in the schema, and MapLibre
        // warns once per missing image. Restricting to what a cyclist stops for keeps the
        // console clean and the map uncluttered — and every name here exists in
        // `public/sprites/light.json`.
        filter: [
          'in',
          ['get', 'kind'],
          ['literal', [
            'drinking_water',
            'cafe',
            'fast_food',
            'restaurant',
            'bench',
            'toilets',
            'train_station',
            'bus_stop',
            'ferry_terminal',
            'supermarket',
            'park',
            'peak',
          ]],
        ],
        layout: {
          'icon-image': ['get', 'kind'],
          'icon-size': 0.8,
          'text-field': ['get', 'name'],
          'text-font': REGULAR,
          'text-size': 10,
          'text-anchor': 'top',
          'text-offset': [0, 0.9],
          'text-optional': true,
        },
        paint: {
          'text-color': COLOURS.text.labelMuted,
          'text-halo-color': COLOURS.text.halo,
          'text-halo-width': 1.2,
        },
      },
      {
        id: 'place-labels',
        type: 'symbol',
        source: 'basemap',
        'source-layer': 'places',
        // The schema carries the zoom at which each place is *meant* to appear. Honouring it
        // is what stops every hamlet in the county appearing at z8.
        filter: ['all', ['has', 'name'], ['>=', ['zoom'], ['get', 'min_zoom']]],
        layout: {
          'text-field': ['get', 'name'],
          'text-font': MEDIUM,
          // Scaled by settlement kind as well as zoom, so a city does not read as equal in
          // weight to the neighbourhood next to it.
          //
          // `zoom` has to be the input to the *top-level* interpolate — nesting it inside the
          // `match` is a style validation error, and MapLibre reports it as an `error` event
          // on the map rather than a thrown exception, so the map simply fails to load.
          'text-size': [
            'interpolate',
            ['linear'],
            ['zoom'],
            8,
            ['match', ['get', 'kind'], 'country', 14, 'region', 12, 'locality', 12, 10],
            14,
            ['match', ['get', 'kind'], 'country', 16, 'region', 14, 'locality', 16, 11],
          ],
          'text-max-width': 8,
        },
        paint: {
          'text-color': COLOURS.text.label,
          'text-halo-color': COLOURS.text.halo,
          'text-halo-width': 1.5,
        },
      },
    ],
  }
}
