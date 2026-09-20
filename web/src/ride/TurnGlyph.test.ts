import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// Plain `createElement`, not JSX: the suite's include pattern is `.test.ts`, and this is the
// only test in it that renders a component at all.
import TurnGlyph from './TurnGlyph'
import type { TurnKind } from './turns'

const KINDS: TurnKind[] = [
  'left',
  'slight-left',
  'sharp-left',
  'keep-left',
  'right',
  'slight-right',
  'sharp-right',
  'keep-right',
  'u-turn',
  'roundabout',
  'straight',
  'end',
  'beeline',
]

/**
 * Where a curve reaches that none of the coordinates under it states.
 *
 * Only the U-turn has one: its arc is a semicircle about (12, 13) with r 4, so the ink goes
 * three units above the 13 either end of the arc is drawn at. Everything else is straight
 * lines and one circle, both of which say outright where they go.
 */
const CROWNS: Partial<Record<TurnKind, number>> = { 'u-turn': 9 }

/** Every y an SVG path states outright. Arcs are covered by {@link CROWNS}. */
function statedYs(d: string): number[] {
  const ys: number[] = []
  for (const command of d.trim().split(/(?=[A-Za-z])/)) {
    const letter = command[0]
    const numbers = (command.slice(1).match(/-?[\d.]+/g) ?? []).map(Number)
    if (letter === 'M' || letter === 'L') ys.push(...numbers.filter((_, i) => i % 2 === 1))
    else if (letter === 'V') ys.push(...numbers)
    else if (letter === 'A') ys.push(numbers[6])
  }
  return ys
}

/**
 * The top and bottom of the ink as it is actually drawn — the shape's own coordinates, moved
 * by whatever the component translated the group by.
 */
function inkSpan(kind: TurnKind): [number, number] {
  const markup = renderToStaticMarkup(createElement(TurnGlyph, { kind }))
  const ys: number[] = [...(kind in CROWNS ? [CROWNS[kind]!] : [])]
  for (const [, d] of markup.matchAll(/ d="([^"]+)"/g)) ys.push(...statedYs(d))
  for (const [, circle] of markup.matchAll(/<circle([^>]+)>/g)) {
    const cy = Number(circle.match(/cy="([\d.]+)"/)?.[1])
    const r = Number(circle.match(/r="([\d.]+)"/)?.[1])
    ys.push(cy - r, cy + r)
  }

  const shift = Number(markup.match(/transform="translate\(0 (-?[\d.]+)\)"/)?.[1])
  expect(shift).not.toBeNaN()
  return [Math.min(...ys) + shift, Math.max(...ys) + shift]
}

describe('the turn glyph', () => {
  /**
   * The box is what the flex rows on the callout line and the navigation page centre against,
   * so the ink has to be centred in the box or the words sit beside a gap.
   */
  it('puts the middle of every kind of ink on the middle of the box', () => {
    // Within a fiftieth of a unit: both the coordinates and the shift are written to two
    // decimal places, which is a hundredth of a unit — a fiftieth of a pixel at the size the
    // navigation page draws it.
    const off = KINDS.map((kind) => {
      const [top, bottom] = inkSpan(kind)
      return [kind, Math.abs((top + bottom) / 2 - 12) > 0.02] as const
    }).filter(([, wrong]) => wrong)
    expect(off).toEqual([])
  })

  it('keeps every kind inside the box it is drawn in', () => {
    // The stroke is 2 wide and round-capped, so the ink reaches 1 past the path either way.
    const outside = KINDS.filter((kind) => {
      const [top, bottom] = inkSpan(kind)
      return top < 1 || bottom > 23
    })
    expect(outside).toEqual([])
  })

  it('moves the drawing rather than the box', () => {
    const markup = renderToStaticMarkup(createElement(TurnGlyph, { kind: 'sharp-right' }))
    expect(markup).toContain('viewBox="0 0 24 24"')
    // A sharp turn folds its head back down beside its own stem, so it is the kind that sat
    // lowest in the box: 4.5 units, a fifth of the glyph.
    expect(markup).toContain('transform="translate(0 -4.50)"')
  })

  it('shifts each kind by its own amount rather than the family by one', () => {
    // Straight on, the head nearly reaches the top of the box and the ink was 1 unit low; a
    // sharp turn was 4.5. One constant would leave both ends of the set wrong.
    const shiftOf = (kind: TurnKind) =>
      Number(
        renderToStaticMarkup(createElement(TurnGlyph, { kind })).match(
          /translate\(0 (-?[\d.]+)\)/,
        )?.[1],
      )
    expect(shiftOf('straight')).toBeCloseTo(-1, 5)
    expect(shiftOf('right')).toBeCloseTo(-3.34, 2)
    expect(shiftOf('sharp-right')).toBeCloseTo(-4.5, 5)
  })
})
