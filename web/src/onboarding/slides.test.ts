import { describe, expect, it } from 'vitest'
import { BIKES, SLIDES, bikeById } from './slides'
import { GLYPHS, GLYPH_SOURCE, toGlyph } from './glyphs'
import { PROFILES } from '../ride/profiles'
import { POSITIONS, TYRES } from '../ride/rider'

describe('the walkthrough', () => {
  it('ends on the location card, because it is the only one that asks for something', () => {
    expect(SLIDES[SLIDES.length - 1].location).toBe(true)
    expect(SLIDES.filter((s) => s.location)).toHaveLength(1)
  })

  it('asks about the bike exactly once', () => {
    expect(SLIDES.filter((s) => s.bikes)).toHaveLength(1)
  })

  it('has a drawn glyph for every card', () => {
    for (const slide of SLIDES) expect(GLYPHS[slide.glyph]).toBeDefined()
  })
})

describe('the bike question', () => {
  /*
   * Every one of these three lands somewhere real. A renamed profile or a withdrawn tyre id
   * would otherwise write a setting the rest of the app silently falls back out of, and the
   * rider would never know the answer they gave had been discarded.
   */
  it('maps every bike onto a profile, a position and a tyre that exist', () => {
    for (const bike of BIKES) {
      expect(PROFILES.map((p) => p.id)).toContain(bike.profile)
      expect(POSITIONS.map((p) => p.id)).toContain(bike.position)
      expect(TYRES.map((t) => t.id)).toContain(bike.tyres)
    }
  })

  /*
   * The three cards are a fixed vocabulary — Relaxed, Fast, Off-road. A bike that suggested a
   * profile outside them would put a fourth name into the trio for one answer.
   */
  it('only ever suggests one of the three offered styles', () => {
    const offered = PROFILES.slice(0, 3).map((p) => p.id)
    for (const bike of BIKES) expect(offered).toContain(bike.profile)
  })

  it('falls back rather than throwing on an id that is no longer offered', () => {
    expect(bikeById('penny-farthing')).toBe(BIKES[0])
  })
})

describe('the glyphs', () => {
  it('pads every row to the grid width, so a short row cannot shift the drawing left', () => {
    for (const [name, rows] of Object.entries(GLYPH_SOURCE)) {
      const glyph = toGlyph([...rows])
      expect(glyph.every((row) => row.length === 20), `${name} has a ragged row`).toBe(true)
    }
  })

  it('draws every glyph on the same 14-row grid', () => {
    for (const glyph of Object.values(GLYPHS)) expect(glyph).toHaveLength(14)
  })

  /* A glyph of nothing renders an empty slate tile, which looks like a failed image load. */
  it('leaves no glyph blank', () => {
    for (const [name, glyph] of Object.entries(GLYPHS)) {
      const lit = glyph.flat().filter(Boolean).length
      expect(lit, `${name} is empty`).toBeGreaterThan(20)
    }
  })
})
