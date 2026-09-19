import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { GRADE_BANDS } from './ride/gradeScale'
import { ROUTE_PALETTE } from './ride/profiles'
import { ROAD_COLOURS } from './ride/ways'
import { deltaE2000 } from './map/colour'

/**
 * The contrast the light chrome has to earn.
 *
 * ## Why this test did not exist before
 *
 * The app was dark, and a dark app gets one thing for free: a light-grey label on near-black
 * passes every contrast rule without anyone thinking about it. Light chrome does not. `--muted`
 * at `#5c6b74` on `#f6f5f1` is a real decision with a real number behind it, and the number is
 * the kind that drifts a shade at a time — each step defensible, the sum unreadable in
 * sunlight on a hillside, which is the one place this app is used and the one place nobody is
 * testing.
 *
 * So the token values are parsed out of `tokens.css` and measured. The point is not that the
 * current values pass — they were chosen to. The point is that a future edit that quietly
 * breaks one fails a build instead of a ride.
 *
 * ## What it does not cover
 *
 * Route line colours, which are held to a **ΔE floor against the basemap** in `style.test.ts`
 * instead. That is a different question — "can this be mistaken for a road" rather than "can
 * this be read" — and the two must not be conflated: a route line is deliberately far more
 * saturated than anything contrast ratio has an opinion about.
 */

const CSS = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')

/**
 * The value of a token inside a given block.
 *
 * Parsed rather than imported, because CSS custom properties have no other reachable
 * representation from a test — and parsing is what makes this test measure *what ships* rather
 * than a second copy of the palette maintained beside it.
 */
function token(name: string, theme: 'light' | 'dark'): string {
  const block =
    theme === 'light'
      ? CSS.slice(CSS.indexOf(':root {'), CSS.indexOf("[data-chrome='dark']"))
      : CSS.slice(CSS.indexOf("[data-chrome='dark']"))
  const match = block.match(new RegExp(`--${name}:\\s*([^;]+);`))
  if (!match) throw new Error(`no --${name} in the ${theme} block`)
  return match[1].trim()
}

/**
 * A token as an opaque hex, resolving the two ways it can fail to be one.
 *
 * `--ink` in the dark block is `var(--slate-100)`, so indirection has to resolve. And several
 * tokens are deliberately translucent — `--fill` on the dark theme is a 55% slate — so they are
 * composited over the surface they are actually drawn on. Measuring the raw value instead is
 * how a test reports `NaN` and a reviewer concludes the test is broken rather than the token
 * being unreadable.
 */
function hexOf(name: string, theme: 'light' | 'dark', over = 'card'): string {
  const value = token(name, theme)
  const indirect = value.match(/^var\(--([a-z0-9-]+)\)$/)
  if (indirect) {
    const match = CSS.match(new RegExp(`--${indirect[1]}:\\s*(#[0-9a-f]{3,6});`, 'i'))
    if (!match) throw new Error(`cannot resolve ${value}`)
    return match[1]
  }
  const rgba = value.match(/^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\/\s*(\d+)%\s*\)$/)
  if (rgba) {
    const [, r, g, b, a] = rgba
    return composite([+r, +g, +b], +a / 100, hexOf(over, theme, 'page'))
  }
  return value
}

/** Source-over: a translucent token painted on an opaque backdrop. */
function composite(rgb: [number, number, number], alpha: number, backdrop: string): string {
  const h = backdrop.replace('#', '')
  const back = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
  return (
    '#' +
    rgb
      .map((c, i) => Math.round(c * alpha + back[i] * (1 - alpha)))
      .map((c) => c.toString(16).padStart(2, '0'))
      .join('')
  )
}

function srgbToLinear(channel: number): number {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function relativeLuminance(hex: string): number {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const [r, g, b] = [0, 2, 4].map((i) => srgbToLinear(parseInt(full.slice(i, i + 2), 16)))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2 contrast ratio, 1:1 to 21:1. */
function contrast(one: string, two: string): number {
  const [a, b] = [relativeLuminance(one), relativeLuminance(two)].sort((x, y) => y - x)
  return (a + 0.05) / (b + 0.05)
}

const THEMES = ['light', 'dark'] as const

describe.each(THEMES)('%s chrome', (theme) => {
  const on = (name: string) => hexOf(name, theme)

  /*
   * 4.5:1 is the AA floor for body text, and this app's body text is 15–17px on a phone held at
   * arm's length in daylight. There is no argument for going under it here.
   */
  it('reads ink on the page and on a card', () => {
    expect(contrast(on('ink'), on('page'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(on('ink'), on('card'))).toBeGreaterThanOrEqual(4.5)
  })

  /*
   * `--muted` carries every note under every row, and every one of them is a real sentence a
   * rider is expected to read — not decoration. It is held to the same 4.5 as `--ink`.
   */
  it('reads muted text on every surface it is used on', () => {
    for (const surface of ['page', 'card', 'inset', 'fill'] as const) {
      expect(contrast(on('muted'), on(surface)), `muted on ${surface}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  /*
   * `--faint` is deliberately quieter: timestamps, a footnote, the chevron on a row. 3:1 is the
   * large-text and non-text floor, and that is what it is for — it must never carry a sentence
   * that changes what the rider does.
   */
  it('keeps faint text above the non-text floor', () => {
    expect(contrast(on('faint'), on('page'))).toBeGreaterThanOrEqual(3)
    expect(contrast(on('faint'), on('card'))).toBeGreaterThanOrEqual(3)
  })

  /* A filled button whose label cannot be read is the worst possible one, because it is the
     one the thumb goes to without looking. */
  it('reads a label on the filled primary', () => {
    expect(contrast(on('on-ink'), on('ink'))).toBeGreaterThanOrEqual(4.5)
  })

  /*
   * The riding bar and the aim strip.
   *
   * They exist to be *read at a glance while moving*, which is the hardest reading condition
   * this app has, and they are the one surface whose colours are not the card's. The figures on
   * them are the ride — elapsed, ridden, climbed — so they take the 4.5 body floor; the fix line
   * under them is a footnote and takes 3.
   *
   * Composited over `--mode` rather than over the card, because that is where they are actually
   * drawn, and measuring a translucent white against a white card is how a token that is
   * invisible in practice passes a test.
   */
  it('reads what is on a mode surface', () => {
    const over = (name: string) => hexOf(name, theme, 'mode')
    expect(contrast(over('mode-ink'), on('mode'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(over('mode-muted'), on('mode'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(over('mode-faint'), on('mode'))).toBeGreaterThanOrEqual(3)
  })

  /*
   * And the bar has to separate from the *planning* card, because that difference is the whole
   * feature: a rider glancing down has to be able to tell navigating from planning before they
   * have read a word. ΔE rather than contrast — the question is "are these two surfaces the
   * same colour", not "can text be read on them".
   */
  it('keeps the mode surface distinct from the card it replaces', () => {
    expect(deltaE2000(hexOf('mode', theme), hexOf('card', theme))).toBeGreaterThanOrEqual(20)
  })

  /* Good and bad name a state and are the only hues in the chrome, so they have to survive the
     tinted backgrounds they are paired with. */
  it('reads the two state colours on their own tints', () => {
    expect(contrast(on('good'), on('good-bg'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(on('bad'), on('bad-bg'))).toBeGreaterThanOrEqual(4.5)
  })

  /*
   * The gradient bars are the riding HUD's lookahead, glanced at for well under a second at
   * speed. They are graphical rather than text, so 3:1 — but against `--card`, because the HUD
   * is a panel and on the light theme that panel is white. These colours were chosen for a
   * slate panel and this is the assertion that would have caught it if one of them had not
   * survived the move.
   */
  it('separates every gradient band from the panel it is drawn on', () => {
    for (const band of GRADE_BANDS) {
      expect(contrast(band.colour, on('card')), `${band.label} on the panel`).toBeGreaterThanOrEqual(3)
    }
  })
})

/**
 * The surface strip's four colours.
 *
 * Drawn on the same panel as the gradient bands, an inch below them, so they answer to the
 * same contrast window: 3:1 on white and on `#11212d` at once, which confines every one to a
 * relative luminance of roughly 0.14 to 0.30. That window is about 2:1 wide, so four classes
 * cannot be separated by lightness and separate by hue at a held lightness instead.
 *
 * The three floors below are not all the same number, and the differences are the argument.
 */
describe('the surface strip', () => {
  const swatches = Object.entries(ROAD_COLOURS)

  it('reads on both themes, being graphical rather than text', () => {
    for (const [role, colour] of swatches) {
      expect(contrast(colour, '#ffffff'), `${role} on the light card`).toBeGreaterThanOrEqual(3)
      expect(contrast(colour, '#11212d'), `${role} on the dark card`).toBeGreaterThanOrEqual(3)
    }
  })

  /*
   * The four cells are read by comparing them, so this is the floor that matters most, and it
   * is the one with the most room: the worst pair is `path` against `road` at ΔE 27.4.
   */
  it('keeps every pair of cells clearly apart', () => {
    for (let i = 0; i < swatches.length; i++) {
      for (let j = i + 1; j < swatches.length; j++) {
        expect(
          deltaE2000(swatches[i][1], swatches[j][1]),
          `${swatches[i][0]} against ${swatches[j][0]}`,
        ).toBeGreaterThanOrEqual(18)
      }
    }
  })

  /*
   * Against the gradient bands, and this floor is 13 rather than the 18 above. That is a
   * deliberate trade and it is worth stating so it does not become folklore.
   *
   * The warm arc inside the contrast window is already occupied — `very steep`, `brutal`,
   * `mtb` and `recorded` all live there — and a red for `main` clearing 15 from all of them
   * does not exist. A cube sweep returns a dusty rose at L* 60.6, fifteen points lighter than
   * the other three cells, which reads as one pale outlier rather than as a warning. What is
   * being risked at 13.1 is confusing a 10 px strip cell with an area chart's fill: two
   * different objects an inch apart, never adjacent, and the two bands it comes nearest —
   * `brutal` and `very steep` — mean "be careful", which is what the cell means too.
   */
  it('stays clear of the gradient bands drawn just above it', () => {
    for (const [role, colour] of swatches) {
      for (const band of GRADE_BANDS) {
        expect(
          deltaE2000(colour, band.colour),
          `${role} against ${band.label}`,
        ).toBeGreaterThanOrEqual(13)
      }
    }
  })

  /*
   * And against the route colours, at 11 — the weakest of the three floors, because it guards
   * the weakest confusion. A route colour appears as a line on the map and as a swatch beside
   * a name; a strip cell is a band in a chart. They are never side by side and never mean the
   * same kind of thing. Worst measured is `main` against `mtb` at ΔE 12.0.
   */
  it('stays clear of the route line colours', () => {
    for (const [role, colour] of swatches) {
      for (const profile of ROUTE_PALETTE) {
        expect(
          deltaE2000(colour, profile.colour),
          `${role} against the ${profile.id} route`,
        ).toBeGreaterThanOrEqual(11)
      }
    }
  })
})

describe('the gradient scale', () => {
  /*
   * The other half of the band rule, and the half that is easy to lose while fixing the first.
   *
   * Darkening a band to clear the panel moves it towards its neighbour, and two adjacent bands
   * that read as the same colour destroy the scale — severity is read by *comparing* bars, so
   * "rising" and "steep" being hard to tell apart is worse than either being slightly pale.
   * ΔE 10 is comfortably above the ~2.3 just-noticeable threshold and is what the six currently
   * clear.
   */
  it('keeps every adjacent pair distinguishable', () => {
    for (let i = 1; i < GRADE_BANDS.length; i++) {
      const [a, b] = [GRADE_BANDS[i - 1], GRADE_BANDS[i]]
      expect(
        deltaE2000(a.colour, b.colour),
        `${a.label} against ${b.label}`,
      ).toBeGreaterThanOrEqual(10)
    }
  })

  /*
   * The severity ramp, which is the half of the scale that *is* about lightness.
   *
   * Hue carries "which band"; lightness carries "worse than the one before". Flattening it
   * while fixing the contrast is the easy mistake — two bands scaled to the same contrast
   * target land on the same luminance — and a steeper road that looks lighter than a shallower
   * one is a scale that lies. `flat` is deliberately not in this list: it is not a severity,
   * and it sits between `rising` and `steep` by luminance on purpose.
   */
  it('darkens with severity, from rising to brutal', () => {
    const climbing = GRADE_BANDS.filter((b) => b.from >= 0.03)
    for (let i = 1; i < climbing.length; i++) {
      expect(
        relativeLuminance(climbing[i].colour),
        `${climbing[i].label} against ${climbing[i - 1].label}`,
      ).toBeLessThan(relativeLuminance(climbing[i - 1].colour))
    }
  })
})

describe('the two themes', () => {
  /*
   * The dark theme is the light one re-mapped, not a second design. Every role token has to
   * exist in both — a name defined only in `:root` silently keeps its light value on the dark
   * theme, which is exactly how a white card ends up on a black page.
   */
  it('defines every role token in both', () => {
    const ROLES = [
      'page', 'card', 'inset', 'fill', 'track',
      'ink', 'muted', 'faint', 'on-ink',
      'mode', 'mode-ink', 'mode-muted', 'mode-faint', 'mode-fill',
      'hairline', 'edge', 'edge-strong',
      'good', 'good-bg', 'good-fill', 'bad', 'bad-bg',
      'panel', 'panel-strong', 'panel-row', 'scrim',
      'lift-button', 'lift-panel', 'lift-sheet', 'lift-row',
    ]
    for (const role of ROLES) {
      expect(() => token(role, 'light'), `--${role} in light`).not.toThrow()
      expect(() => token(role, 'dark'), `--${role} in dark`).not.toThrow()
    }
  })

  /* The whole point of the pair. If they ever agree, one of them is not a theme. */
  it('inverts, rather than merely tinting', () => {
    expect(relativeLuminance(hexOf('page', 'light'))).toBeGreaterThan(0.5)
    expect(relativeLuminance(hexOf('page', 'dark'))).toBeLessThan(0.1)
  })
})
