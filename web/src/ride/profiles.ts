/**
 * The routing profiles the app offers, and the colours they are drawn in.
 *
 * Split out from `useRoute` so that anything needing to know what a profile *is* — the map
 * layers, the sheet, a test — can ask without pulling in the engine client and the Worker
 * that comes with it.
 */

/**
 * The profiles shipped in `public/profiles2`, in the order a cyclist is likely to want them.
 *
 * ## Why these colours
 *
 * A route line has two jobs: it must not be mistaken for the map underneath it, and several
 * of them at once must be told apart. The first job is the one the original muted palette
 * failed, and it failed it *measurably* — `shortest` was ΔE 7.5 from the light theme's
 * boundary colour and 9.1 from the dark theme's main roads. It was not a low-contrast road
 * colour; it was a road colour.
 *
 * The fix is chroma, not hue. Every **stroke** in both basemap palettes is C ≤ 15.4 — the
 * map's linework is essentially neutral by construction — so a line at C ≥ 45 cannot read as
 * map furniture whatever its hue. That single constraint does more work than any amount of
 * hue-picking, and it is why these are vivid where the surrounding chrome is not: the chrome
 * sits on a panel we control, and the line sits on terrain we do not.
 *
 * Land **fills** are deliberately above that ceiling — up to C 24.9 — because the argument
 * only ever applied to lines. See `PALETTES` in `src/map/style.ts`.
 *
 * Lightness is floored at L* 56 so nothing disappears into the dark basemap, and each line
 * carries a dark casing so nothing disappears into the light one.
 *
 * Measured over both palettes and simulated deuteranopia, protanopia and tritanopia: worst
 * adjacent pair ΔE 26.4 for normal vision (was 13.9).
 *
 * The closest approach to any basemap colour is **ΔE 17.15**, `fastbike` against the light
 * theme's water. An earlier version of this comment claimed ΔE 18.0, which was wrong: that
 * figure was measured over the basemap's fills and strokes but *not* its label colours, and
 * `fastbike` sat ΔE 15.5 from the dark theme's water label the whole time. The label was
 * lifted when the land-cover palette landed, so 17.15 is both correct and an improvement on
 * what shipped. `style.test.ts` now asserts a floor of 16 over every colour in the palette,
 * labels included, so the figure cannot drift again unnoticed.
 *
 * ## What this palette does not do
 *
 * Six categorical colours cannot all separate under dichromacy — a dichromat has roughly one
 * usable hue axis, so beyond about three categories the remaining separation has to come from
 * lightness, and there is not enough of it to go round six. The worst pair here is
 * `fastbike-verylowtraffic` against `shortest` at ΔE 8.3 under deuteranopia; violet and cyan
 * both collapse towards blue. That is a real limit, not an oversight, and it is survivable
 * only because **identity is never colour alone**: every row carries a label and a swatch,
 * the chosen route is separated by width as well as hue, and the detail view names it.
 *
 * Assigned by profile and never cycled, so ticking a fourth profile cannot repaint the three
 * already on screen — which would make the map unreadable exactly when you are reading it.
 */
export const PROFILES = [
  {
    id: 'trekking',
    label: 'Trekking',
    note: 'The sane default — quiet roads and decent surfaces',
    colour: '#fec241',
  },
  { id: 'fastbike', label: 'Fast', note: 'Road bike; prefers speed over quiet', colour: '#28aeff' },
  { id: 'gravel', label: 'Gravel', note: 'Happy on unsurfaced tracks', colour: '#389f48' },
  {
    id: 'fastbike-verylowtraffic',
    label: 'Fast, quiet',
    note: 'Road bike, traffic-averse',
    colour: '#b56daf',
  },
  { id: 'mtb', label: 'MTB', note: 'Off-road', colour: '#fb3850' },
  {
    id: 'shortest',
    label: 'Shortest',
    note: 'Distance only, ignores surface and traffic',
    colour: '#33e2d8',
  },
] as const

export type ProfileId = (typeof PROFILES)[number]['id']

export const profileById = (id: string) => PROFILES.find((p) => p.id === id) ?? PROFILES[0]
