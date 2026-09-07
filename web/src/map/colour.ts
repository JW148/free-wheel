/**
 * Just enough colour science to make the basemap's palette rules *executable*.
 *
 * `docs/phase-4-progress.md` records the constraints that keep a route line readable against
 * the map — a chroma ceiling on basemap colours, a ΔE floor between route colours and the
 * surfaces they cross. Those were measured once, by hand, and then written down as prose. Prose
 * does not fail a build. A palette edited six months later can quietly violate every one of
 * them and nothing complains until someone is squinting at a phone on a hillside.
 *
 * So the rules live in `style.test.ts` as assertions instead, and this module is what they
 * measure with. Nothing here is used at runtime; it exists for the tests.
 *
 * CIELAB with a D65 white point, and CIEDE2000 for perceptual distance. CIEDE2000 rather than
 * plain Euclidean ΔE because the whole question is "do these two read as different colours",
 * which is exactly what it was fitted to predict — and because it is the formula the existing
 * figures in `docs/phase-4-progress.md` were computed with, so the numbers stay comparable.
 */

export interface Lab {
  L: number
  a: number
  b: number
}

/** A colour to measure: `#rgb`, `#rrggbb`, or an already-computed Lab triple. */
export type Colour = string | Lab

const D65 = { X: 0.95047, Y: 1.0, Z: 1.08883 }

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`not a hex colour: ${hex}`)
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ]
}

/** Undo the sRGB transfer function. The 0.04045 knee is the piecewise part people drop. */
function toLinear(channel: number): number {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

export function hexToLab(hex: string): Lab {
  const [r8, g8, b8] = parseHex(hex)
  const r = toLinear(r8)
  const g = toLinear(g8)
  const b = toLinear(b8)

  const X = r * 0.4124564 + g * 0.3575761 + b * 0.1804375
  const Y = r * 0.2126729 + g * 0.7151522 + b * 0.072175
  const Z = r * 0.0193339 + g * 0.119192 + b * 0.9503041

  // The 216/24389 and 841/108 constants are the CIE's exact rational forms. The rounded
  // 0.008856 / 7.787 pair in circulation costs a little accuracy near black, which matters
  // here because the dark theme's earth sits at L* 7.
  const f = (t: number): number =>
    t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29

  const fx = f(X / D65.X)
  const fy = f(Y / D65.Y)
  const fz = f(Z / D65.Z)

  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) }
}

function toLab(colour: Colour): Lab {
  return typeof colour === 'string' ? hexToLab(colour) : colour
}

/** CIELAB L*: 0 is black, 100 is white. */
export function lightness(colour: Colour): number {
  return toLab(colour).L
}

/**
 * CIELCh chroma — how colourful, independent of how light.
 *
 * This is the number the basemap rule is written in. Chroma rather than saturation because a
 * route line has to stay distinct from surfaces at very different lightnesses, and saturation
 * folds lightness back in.
 */
export function chroma(colour: Colour): number {
  const { a, b } = toLab(colour)
  return Math.hypot(a, b)
}

/** CIELCh hue angle in degrees, 0-360. */
export function hue(colour: Colour): number {
  const { a, b } = toLab(colour)
  return ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360
}

const rad = (deg: number): number => (deg * Math.PI) / 180

/**
 * CIEDE2000 colour difference. Verified against all 13 pairs of Sharma, Wu & Dalal's reference
 * data in `colour.test.ts`.
 *
 * Roughly: ~1 is the smallest difference a person can see side by side, ~2.3 is the classic
 * just-noticeable difference, and the old palette's park-vs-building measured 2.8.
 */
export function deltaE2000(one: Colour, two: Colour): number {
  const { L: L1, a: a1, b: b1 } = toLab(one)
  const { L: L2, a: a2, b: b2 } = toLab(two)

  const C1 = Math.hypot(a1, b1)
  const C2 = Math.hypot(a2, b2)
  const Cbar = (C1 + C2) / 2

  // The a* axis is stretched for low-chroma colours, which is what stops two near-neutrals
  // reading as further apart than they are.
  const pow7 = (x: number): number => x ** 7
  const G = Cbar > 0 ? 0.5 * (1 - Math.sqrt(pow7(Cbar) / (pow7(Cbar) + pow7(25)))) : 0

  const a1p = (1 + G) * a1
  const a2p = (1 + G) * a2
  const C1p = Math.hypot(a1p, b1)
  const C2p = Math.hypot(a2p, b2)

  // atan2(0, 0) is 0, which is the convention the formula wants for a neutral.
  const h1p = ((Math.atan2(b1, a1p) * 180) / Math.PI + 360) % 360
  const h2p = ((Math.atan2(b2, a2p) * 180) / Math.PI + 360) % 360

  const dLp = L2 - L1
  const dCp = C2p - C1p

  // Hue difference is undefined when either colour is neutral, and the formula says to treat
  // it as zero rather than letting an arbitrary angle leak in. Sharma pairs 7 and 8 exist to
  // catch an implementation that skips this.
  const neutral = C1p * C2p === 0
  let dhp: number
  if (neutral) dhp = 0
  else if (Math.abs(h2p - h1p) <= 180) dhp = h2p - h1p
  else if (h2p - h1p > 180) dhp = h2p - h1p - 360
  else dhp = h2p - h1p + 360

  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp) / 2)

  const Lbar = (L1 + L2) / 2
  const Cbarp = (C1p + C2p) / 2

  // Mean hue, taking the short way round the circle.
  let hbarp: number
  if (neutral) hbarp = h1p + h2p
  else if (Math.abs(h1p - h2p) <= 180) hbarp = (h1p + h2p) / 2
  else if (h1p + h2p < 360) hbarp = (h1p + h2p + 360) / 2
  else hbarp = (h1p + h2p - 360) / 2

  const T =
    1 -
    0.17 * Math.cos(rad(hbarp - 30)) +
    0.24 * Math.cos(rad(2 * hbarp)) +
    0.32 * Math.cos(rad(3 * hbarp + 6)) -
    0.2 * Math.cos(rad(4 * hbarp - 63))

  const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2))
  const Rc =
    Cbarp > 0 ? 2 * Math.sqrt(pow7(Cbarp) / (pow7(Cbarp) + pow7(25))) : 0

  const SL =
    1 + (0.015 * (Lbar - 50) ** 2) / Math.sqrt(20 + (Lbar - 50) ** 2)
  const SC = 1 + 0.045 * Cbarp
  const SH = 1 + 0.015 * Cbarp * T
  // The rotation term. It only bites in the blues, which is precisely where this basemap
  // spends water, roads and boundaries.
  const RT = -Rc * Math.sin(rad(2 * dTheta))

  return Math.sqrt(
    (dLp / SL) ** 2 +
      (dCp / SC) ** 2 +
      (dHp / SH) ** 2 +
      RT * (dCp / SC) * (dHp / SH),
  )
}
