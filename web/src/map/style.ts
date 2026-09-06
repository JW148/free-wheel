import type { FilterSpecification, StyleSpecification } from 'maplibre-gl'

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

interface Palette {
  earth: string
  water: string
  green: string
  building: string
  road: string
  roadCasing: string
  major: string
  /**
   * Three tones of one warm hue, not three hues. See the `paths` layer for why the separation
   * is carried by dash pattern instead.
   */
  pathCycle: string
  pathTrack: string
  pathFoot: string
  boundary: string
  label: string
  labelMuted: string
  labelWater: string
  /**
   * Labels sit directly on top of map geometry, so every one gets a halo in the background
   * colour. Without it, a street name disappears wherever it crosses a park.
   */
  halo: string
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
 */
const PALETTES: Record<MapTheme, Palette> = {
  dark: {
    earth: '#06141b',
    water: '#12293a',
    green: '#0f2219',
    building: '#11212d',
    road: '#46596a',
    roadCasing: '#06141b',
    major: '#6a8090',
    // Paths read warm against the cool slate, so a traffic-free way is distinguishable from
    // tarmac at a glance rather than on inspection. It is the only warmth anywhere in the
    // basemap, which is what makes it legible — and why all three tones share one hue.
    //
    // The separation between them is lightness at held chroma, never more saturation:
    // `pathTrack` sits at CIELCh C 15.1, which *is* the ceiling `docs/phase-4-progress.md`
    // records for the whole basemap. A brighter cycleway by saturation would have measured
    // C 20.7 and broken the one constraint that keeps a route line from reading as map
    // furniture. L* 52 / 40 / 29.5 at h 81.
    pathCycle: '#8a7a63',
    pathTrack: '#6b5c46',
    pathFoot: '#4e4436',
    boundary: '#253745',
    label: '#ccd0cf',
    labelMuted: '#9ba8ab',
    labelWater: '#7590a3',
    halo: '#06141b',
  },
  light: {
    earth: '#eef0ef',
    water: '#c3d0d8',
    green: '#dde3dd',
    building: '#dfe3e2',
    road: '#ffffff',
    roadCasing: '#c8ccca',
    major: '#f0ede4',
    // Inverted on the daylight map: the *darkest* tone is the most prominent, because these
    // sit against a near-white earth. L* 58 / 70 / 79 at h 81, all C <= 15.
    pathCycle: '#9a8972',
    pathTrack: '#baa990',
    pathFoot: '#cfc2b0',
    boundary: '#9ba8ab',
    label: '#11212d',
    labelMuted: '#4a5c6a',
    labelWater: '#4a6b80',
    halo: '#eef0ef',
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
const POLYGONS_ONLY: FilterSpecification = ['==', ['geometry-type'], 'Polygon']

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
 */
const NOT_PATHS: FilterSpecification = ['!=', ['get', 'kind'], 'path']

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
      {
        id: 'landcover',
        type: 'fill',
        source: 'basemap',
        'source-layer': 'landcover',
        filter: POLYGONS_ONLY,
        paint: { 'fill-color': COLOURS.green, 'fill-opacity': 0.6 },
      },
      {
        id: 'landuse',
        type: 'fill',
        source: 'basemap',
        'source-layer': 'landuse',
        filter: POLYGONS_ONLY,
        paint: { 'fill-color': COLOURS.green, 'fill-opacity': 0.5 },
      },
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
        filter: NOT_PATHS,
        paint: {
          'line-color': COLOURS.roadCasing,
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.2, 16, 8],
        },
      },
      {
        id: 'roads',
        type: 'line',
        source: 'basemap',
        'source-layer': 'roads',
        filter: NOT_PATHS,
        paint: {
          'line-color': [
            'match',
            ['get', 'kind'],
            'highway',
            COLOURS.major,
            'major_road',
            COLOURS.major,
            COLOURS.road,
          ],
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 16, 6],
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
        // enough that drawing it there costs legibility for nothing.
        minzoom: 12,
        layout: { 'line-cap': 'round' },
        paint: {
          'line-color': [
            'match',
            ['get', 'kind_detail'],
            'cycleway',
            COLOURS.pathCycle,
            ['track', 'path', 'bridleway'],
            COLOURS.pathTrack,
            COLOURS.pathFoot,
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
        paint: { 'line-color': COLOURS.boundary, 'line-dasharray': [2, 2], 'line-width': 1 },
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
          'text-color': COLOURS.labelWater,
          'text-halo-color': COLOURS.halo,
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
          'text-color': COLOURS.labelMuted,
          'text-halo-color': COLOURS.halo,
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
          'text-color': COLOURS.labelMuted,
          'text-halo-color': COLOURS.halo,
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
          'text-color': COLOURS.label,
          'text-halo-color': COLOURS.halo,
          'text-halo-width': 1.5,
        },
      },
    ],
  }
}
