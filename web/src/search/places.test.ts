import { describe, expect, it } from 'vitest'
import { iconFor, MAX_RECENTS, placeEntry, withRecent, type RecentPlace } from './places'

const at = (name: string, lon: number, lat: number, when = 0): RecentPlace => ({
  name,
  lon,
  lat,
  detail: 'Street',
  at: when,
})

describe('withRecent', () => {
  it('puts the newest first', () => {
    const list = withRecent([at('A', -3.1, 55.9)], at('B', -3.2, 55.9))
    expect(list.map((p) => p.name)).toEqual(['B', 'A'])
  })

  it('moves somewhere already in the list rather than listing it twice', () => {
    const list = withRecent(
      [at('A', -3.1, 55.9), at('B', -3.2, 55.9)],
      at('B', -3.2, 55.9, 10),
    )
    expect(list.map((p) => p.name)).toEqual(['B', 'A'])
    expect(list[0].at).toBe(10)
  })

  it('treats a fix a few metres off as the same place', () => {
    // Setting off from the same corner twice produces two coordinates, never one.
    const list = withRecent([at('A', -3.1, 55.9)], at('A', -3.10005, 55.90002, 10))
    expect(list).toHaveLength(1)
  })

  it('keeps two different places that happen to share a name', () => {
    const list = withRecent([at('High Street', -3.1, 55.9)], at('High Street', -2.7, 55.9))
    expect(list).toHaveLength(2)
  })

  it('drops the oldest once the list is full', () => {
    let list: RecentPlace[] = []
    for (let i = 0; i < MAX_RECENTS + 3; i++) list = withRecent(list, at(`p${i}`, -3 + i / 100, 55.9))
    expect(list).toHaveLength(MAX_RECENTS)
    expect(list[0].name).toBe(`p${MAX_RECENTS + 2}`)
    expect(list.map((p) => p.name)).not.toContain('p0')
  })
})

describe('placeEntry', () => {
  it('falls back to coordinates rather than saving a nameless row', () => {
    expect(placeEntry({ name: '   ', lon: -3.1884, lat: 55.9533 }).name).toBe('55.9533, -3.1884')
  })

  it('guesses the two icons worth guessing, and stars the rest', () => {
    expect(iconFor('Home')).toBe('home')
    expect(iconFor('  work ')).toBe('work')
    expect(iconFor('Office')).toBe('work')
    expect(iconFor('The good bakery')).toBe('star')
  })

  it('lets an explicit icon win over the guess', () => {
    expect(placeEntry({ name: 'Home', lon: 0, lat: 0, icon: 'star' }).icon).toBe('star')
  })
})
