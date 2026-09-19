import { describe, expect, it } from 'vitest'
import {
  drawnRoutes,
  ensureRouteLayers,
  mapTapAction,
  markFeatures,
  routeFeatures,
} from './routeLayers'
import { routeGeometry } from './progress'
import { profileById } from './profiles'

const line = (n: number): [number, number][] => [
  [-3.19, 55.95],
  [-3.19 + n / 100, 55.95],
]

describe('drawnRoutes', () => {
  it("gives a lone route its profile's colour, not a neutral one", () => {
    const drawn = drawnRoutes({ gravel: { coords: line(1) } }, null)
    expect(drawn).toEqual([
      { id: 'gravel', coords: line(1), colour: profileById('gravel').colour, state: 'solo' },
    ])
  })

  it('keeps a lone route in its own colour once it is the chosen one', () => {
    const drawn = drawnRoutes({ gravel: { coords: line(1) } }, 'gravel')
    expect(drawn[0].colour).toBe(profileById('gravel').colour)
    expect(drawn[0].state).toBe('solo')
  })

  it('gives every route its profile colour, equally weighted, while none is chosen', () => {
    const drawn = drawnRoutes(
      { trekking: { coords: line(1) }, gravel: { coords: line(2) } },
      null,
    )
    expect(drawn.map((r) => r.state)).toEqual(['candidate', 'candidate'])
    expect(drawn.map((r) => r.colour)).toEqual([
      profileById('trekking').colour,
      profileById('gravel').colour,
    ])
  })

  it('separates the chosen route from the ones it was compared against', () => {
    const drawn = drawnRoutes(
      { trekking: { coords: line(1) }, gravel: { coords: line(2) }, mtb: { coords: line(3) } },
      'gravel',
    )
    expect(Object.fromEntries(drawn.map((r) => [r.id, r.state]))).toEqual({
      trekking: 'unchosen',
      gravel: 'chosen',
      mtb: 'unchosen',
    })
  })

  /*
   * The shaping run's one frame of honesty. Everything else on screen says "working out your
   * routes"; this is the line itself saying it is about to be replaced.
   */
  it('dims the line a running search is about to replace', () => {
    const drawn = drawnRoutes({ gravel: { coords: line(1) } }, 'gravel', true)
    expect(drawn[0].state).toBe('stale')
  })

  it('drops a whole open comparison to stale, not two thirds of it', () => {
    const drawn = drawnRoutes(
      { trekking: { coords: line(1) }, gravel: { coords: line(2) }, mtb: { coords: line(3) } },
      'gravel',
      true,
    )
    expect(drawn.map((r) => r.state)).toEqual(['stale', 'stale', 'stale'])
  })

  it('treats a choice with no route as no choice at all', () => {
    const drawn = drawnRoutes(
      { trekking: { coords: line(1) }, gravel: { coords: line(2) } },
      'mtb',
    )
    expect(drawn.map((r) => r.state)).toEqual(['candidate', 'candidate'])
  })
})

describe('routeFeatures', () => {
  it('carries the profile id, so a tap on the map can name what it hit', () => {
    const [feature] = routeFeatures([
      { id: 'gravel', coords: line(1), colour: '#5a9e63', state: 'chosen' },
    ]).features
    expect(feature.properties).toEqual({ profile: 'gravel', colour: '#5a9e63', state: 'chosen' })
  })

  it('draws the chosen route last, so it sits on top of its rivals', () => {
    const collection = routeFeatures([
      { id: 'gravel', coords: line(1), colour: '#5a9e63', state: 'chosen' },
      { id: 'mtb', coords: line(2), colour: '#c4707a', state: 'unchosen' },
      { id: 'trekking', coords: line(3), colour: '#b8873c', state: 'unchosen' },
    ])
    expect(collection.features.map((f) => f.properties?.profile)).toEqual([
      'mtb',
      'trekking',
      'gravel',
    ])
  })

  it('skips a degenerate route, which would be a point rather than a line', () => {
    const collection = routeFeatures([
      { id: 'gravel', coords: [[-3.19, 55.95]], colour: profileById('gravel').colour, state: 'solo' },
    ])
    expect(collection.features).toEqual([])
  })
})

describe('mapTapAction', () => {
  const tap = (over: Partial<Parameters<typeof mapTapAction>[0]> = {}) =>
    mapTapAction({
      suspended: false,
      profileUnderTap: null,
      choosing: true,
      clearableChoice: false,
      chosen: null,
      placing: true,
      ...over,
    })

  it('chooses the route under the tap, even with point editing on', () => {
    expect(tap({ profileUnderTap: 'gravel' })).toEqual({ do: 'choose', profile: 'gravel' })
  })

  /*
   * The precedence this file used to have, inverted — and the reason is in `mapTapAction`'s own
   * comment. A tap anywhere used to revert the choice, which was defensible while a third point
   * did nothing. Now a third point is a stop the route runs through, so under the old order a
   * rider who had chosen a route could not place one: the first tap un-chose it, and the second
   * shaped in a style they had not picked.
   */
  it('places a stop on empty map rather than reverting the choice', () => {
    expect(tap({ clearableChoice: true, chosen: 'gravel' })).toEqual({ do: 'place' })
  })

  it('reverts the choice when the tap is on the chosen line itself', () => {
    expect(tap({ profileUnderTap: 'gravel', chosen: 'gravel', clearableChoice: true })).toEqual({
      do: 'clear',
    })
  })

  it('switches to the other route when the tap is on a line that is not the chosen one', () => {
    expect(tap({ profileUnderTap: 'mtb', chosen: 'gravel', clearableChoice: true })).toEqual({
      do: 'choose',
      profile: 'mtb',
    })
  })

  it('places a point once there is nothing left to clear', () => {
    expect(tap({ clearableChoice: false })).toEqual({ do: 'place' })
  })

  /*
   * A lone route is not a comparison — there is no all-colours state to go back to, and
   * clearing would only strip the stats rail and disable Start. The caller reports that as
   * `clearableChoice: false`, and a tap on the line is then a no-op choice rather than a
   * revert, which is what lets a rider shaping a single route tap their own line without
   * losing it.
   */
  it('re-chooses rather than reverting when the only choice is a lone route', () => {
    expect(tap({ profileUnderTap: 'gravel', chosen: 'gravel', clearableChoice: false })).toEqual({
      do: 'choose',
      profile: 'gravel',
    })
  })

  it('does nothing on empty map with editing off', () => {
    expect(tap({ placing: false })).toEqual({ do: 'nothing' })
  })

  /*
   * One map instance serves both screens, so while the region picker is over the ride screen
   * every tap meant for a region arrives here too. Suspension is checked before any intent,
   * not folded into `placing`: a tap during the picker must not choose or clear either, and
   * `placing` is a rider's own toggle that says nothing about who owns the map.
   */
  it('does nothing at all while another screen owns the map', () => {
    expect(tap({ suspended: true })).toEqual({ do: 'nothing' })
    expect(tap({ suspended: true, profileUnderTap: 'gravel' })).toEqual({ do: 'nothing' })
    expect(tap({ suspended: true, clearableChoice: true })).toEqual({ do: 'nothing' })
    expect(tap({ suspended: true, placing: true })).toEqual({ do: 'nothing' })
  })

  it('neither chooses nor clears while riding — the decision is made', () => {
    expect(tap({ profileUnderTap: 'gravel', choosing: false, placing: false })).toEqual({
      do: 'nothing',
    })
    expect(tap({ choosing: false, clearableChoice: true, placing: false })).toEqual({
      do: 'nothing',
    })
  })

  /*
   * The guarantee worth keeping from the old rule, and the only one: riding refuses the map
   * entirely. A bump in the road must not add a stop to the route being followed.
   */
  it('refuses to place a stop while riding, whatever is under the tap', () => {
    expect(tap({ choosing: false, placing: false, chosen: 'gravel' })).toEqual({ do: 'nothing' })
  })
})

describe('ensureRouteLayers', () => {
  /*
   * A stand-in for MapLibre that records the order layers were added in.
   *
   * Insertion order *is* the draw order here — nothing passes a `beforeId` — so it is the one
   * property worth asserting, and the one that silently inverts the next time a layer is added
   * in the wrong place. That failure looks like a styling bug rather than a reordering: a
   * main-road stretch painted over the route line it is supposed to sit beneath.
   */
  const order = (): string[] => {
    const layers: string[] = []
    const map = {
      addSource: () => {},
      getSource: () => undefined,
      addLayer: (layer: { id: string }) => void layers.push(layer.id),
      getLayer: (id: string) => (layers.includes(id) ? { id } : undefined),
      setPaintProperty: () => {},
      setLayoutProperty: () => {},
      hasImage: () => true,
      addImage: () => {},
    }
    ensureRouteLayers(map as unknown as Parameters<typeof ensureRouteLayers>[0], 'light')
    return layers
  }

  it('puts the main-road weight under the casing, and the dash over the line', () => {
    const layers = order()
    const at = (id: string) => layers.indexOf(id)

    expect(at('route-mainroad')).toBeGreaterThan(-1)
    expect(at('route-unpaved')).toBeGreaterThan(-1)

    // Under the casing: the mark is that the line is *heavier* here. Painted on top it would
    // be a second colour on a line whose colour already says which route it is.
    expect(at('route-mainroad')).toBeLessThan(at('route-casing'))
    // Over the line, or a 2.8 px dash under a 6.8 px stroke is not visible at all.
    expect(at('route-unpaved')).toBeGreaterThan(at('route-line'))
    // ...and under the travelled grey, because a road behind you has stopped being a road you
    // are deciding about.
    expect(at('route-unpaved')).toBeLessThan(at('route-travelled'))
  })

  it('keeps the rider above every route layer', () => {
    const layers = order()
    const rider = layers.indexOf('position-halo')
    for (const id of ['route-mainroad', 'route-casing', 'route-line', 'route-unpaved']) {
      expect(layers.indexOf(id)).toBeLessThan(rider)
    }
  })
})

describe('markFeatures', () => {
  const geometry = routeGeometry({
    coords: [
      [-3.2, 55.95],
      [-3.19, 55.95],
      [-3.18, 55.95],
      [-3.17, 55.95],
    ],
    elevations: [0, 0, 0, 0],
    distanceM: 0,
    ascendM: 0,
    timeS: null,
    name: null,
  })!

  it('cuts the route at the marked distances and carries the mark', () => {
    const features = markFeatures(geometry, [
      { fromM: 0, toM: geometry.totalM / 2, mark: 'unpaved' },
    ])
    expect(features.features).toHaveLength(1)
    expect(features.features[0].properties).toEqual({ mark: 'unpaved' })
    expect(features.features[0].geometry.type).toBe('LineString')
  })

  it('drops a mark too short to draw rather than emitting a one-point line', () => {
    // A LineString of one coordinate is invalid GeoJSON, and MapLibre's answer to one is to
    // stop rendering the whole source.
    const features = markFeatures(geometry, [{ fromM: 100, toM: 100, mark: 'main' }])
    expect(features.features).toHaveLength(0)
  })

  it('emits nothing at all when there is nothing marked', () => {
    expect(markFeatures(geometry, []).features).toHaveLength(0)
  })
})
