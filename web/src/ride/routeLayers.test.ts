import { describe, expect, it } from 'vitest'
import { drawnRoutes, mapTapAction, routeFeatures } from './routeLayers'
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
      placing: true,
      ...over,
    })

  it('chooses the route under the tap, even with point editing on', () => {
    expect(tap({ profileUnderTap: 'gravel' })).toEqual({ do: 'choose', profile: 'gravel' })
  })

  /*
   * Reverting a decision beats editing the route. The pin toggle is on by default, so the
   * other order would leave the map gesture unreachable exactly when it is wanted; and a via
   * point that really was intended costs one more tap, which is cheap and obvious.
   */
  it('clears a revertible choice before it places a point', () => {
    expect(tap({ clearableChoice: true })).toEqual({ do: 'clear' })
  })

  it('places a point once there is nothing left to clear', () => {
    expect(tap({ clearableChoice: false })).toEqual({ do: 'place' })
  })

  /*
   * A lone route is not a comparison — there is no all-colours state to go back to, and
   * clearing would only strip the stats rail and disable Start. The caller reports that as
   * `clearableChoice: false`.
   */
  it('places a point when the only choice is a lone route', () => {
    expect(tap({ clearableChoice: false, placing: true })).toEqual({ do: 'place' })
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
})
