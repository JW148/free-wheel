/**
 * Six pixel glyphs, drawn on the same 20×14 grid as the app icon.
 *
 * ## Why pixels, and why not photographs
 *
 * The first design for this screen was six cycling photographs. They were handsome and they
 * were generic: any cycling app could have shipped them, none of them said *this* app, and
 * every one would have had to be licence-checked, resized and committed — roughly a megabyte
 * of assets in an app whose entire point is that it works with the network off.
 *
 * The icon is already a pixel bike on deep slate. Six glyphs in the icon's own two greys, plus
 * the trekking amber that is the app's default route colour, make the walkthrough
 * unmistakably this app, need no licensing, and weigh a few hundred bytes.
 *
 * ## Why a character map rather than images
 *
 * Each glyph is fourteen strings of up to twenty characters. That is editable in place by
 * anyone reading this file, diffs legibly, cannot 404, needs no `image-rendering: pixelated`
 * fight with the browser, and does not add a request to the critical path of a first run —
 * which is, by definition, a cold cache.
 *
 * The renderer turns each row into a CSS grid of spans. At six glyphs of 280 cells it is a
 * rounding error against the map.
 */

/**
 * The palette, by character.
 *
 * Two greys from the icon, one accent, one state colour. Four is the whole budget: the point
 * of the glyphs is that they look like the icon, and the icon is nearly monochrome.
 */
export const GLYPH_COLOURS: Record<string, string> = {
  /** The icon's light grey — the frame, the bulk of every glyph. */
  '#': '#ccd0cf',
  /** Its mid grey: wheels, ground, anything behind the subject. */
  o: '#8fa3ab',
  /** The trekking amber, which is also the app's default route colour. One accent, used once
      per glyph, so the eye is told where to look. */
  a: '#fec241',
  /** The good green, for the one glyph about a place being on the phone. */
  g: '#5a9e63',
  '.': 'transparent',
}

/** A glyph as rows of colour, ready to render. `null` is an empty cell. */
export type Glyph = (string | null)[][]

const WIDTH = 20

/** Pads each row to the grid width and resolves characters to colours. */
export function toGlyph(rows: string[]): Glyph {
  return rows.map((row) =>
    row
      .padEnd(WIDTH, '.')
      .split('')
      .map((ch) => {
        const colour = GLYPH_COLOURS[ch]
        return colour && colour !== 'transparent' ? colour : null
      }),
  )
}

/**
 * The six, in the order the walkthrough tells its story.
 *
 * Each one has to be legible at 12px per cell on a phone, which is what rules out detail: a
 * glyph is a silhouette with one accent, not a picture.
 */
export const GLYPH_SOURCE = {
  /** The icon itself, near enough — routes, with the network off. */
  bike: [
    '',
    '......##.....###....',
    '......#......#......',
    '......#.....#.......',
    '......##...#........',
    '....oooo###ooooo....',
    '...o...o#..#o....o..',
    '..o.....o#..o.....o.',
    '..o.....#o..o.....o.',
    '..o....o.##.o.....o.',
    '...o..o...#.#....o..',
    '....oooo..###oooo...',
    '',
    '',
  ],
  /** Britain, with one region already green — download where you ride. */
  britain: [
    '........##..........',
    '.......####.........',
    '......#####.........',
    '.....######.........',
    '......g###..........',
    '......gg#...........',
    '.......###..........',
    '......#####.........',
    '.....#######........',
    '....#########.......',
    '...##########.......',
    '....#########.......',
    '.....###..##........',
    '',
  ],
  /** Two taps and the line between them. */
  taps: [
    '',
    '..............aa....',
    '.............a##a...',
    '.............a##a...',
    '..............aa....',
    '..............a.....',
    '............aa......',
    '..........aa........',
    '........aa..........',
    '......aa............',
    '..aa..a.............',
    '.a##a...............',
    '.a##a...............',
    '..aa................',
  ],
  /** Two bikes side by side — what are you riding. */
  bikes: [
    '',
    '....##.......##.....',
    '....#.........#.....',
    '...oooo.....oooo....',
    '..o....o###o....o...',
    '..o....o#.#o....o...',
    '..o....#o..o....o...',
    '..o...o.o..o....o...',
    '...oooo..oooo.......',
    '',
    '.....a...........a..',
    '....aaa.........aaa.',
    '.....a...........a..',
    '',
  ],
  /** A hill with a marker at the top — follow it on the road. */
  climb: [
    '',
    '............a.......',
    '............#a......',
    '............#.......',
    '...........###......',
    '..........#####.....',
    '.........#######....',
    '........#########...',
    '.......###########..',
    '......#############.',
    '.....###############',
    '..oooooooooooooooooo',
    '',
    '',
  ],
  /** A locating reticle — where are you. */
  locate: [
    '',
    '.........##.........',
    '.......##..##.......',
    '......#......#......',
    '.....#........#.....',
    '.....#...aa...#.....',
    '....#...aaaa...#....',
    '....#...aaaa...#....',
    '.....#...aa...#.....',
    '.....#........#.....',
    '......#......#......',
    '.......##..##.......',
    '.........##.........',
    '',
  ],
} as const

export type GlyphName = keyof typeof GLYPH_SOURCE

export const GLYPHS: Record<GlyphName, Glyph> = Object.fromEntries(
  Object.entries(GLYPH_SOURCE).map(([name, rows]) => [name, toGlyph([...rows])]),
) as Record<GlyphName, Glyph>
