/**
 * Gradient as a colour, for the elevation strip a rider glances at while moving.
 *
 * ## Why colour and not just shape
 *
 * The strip auto-scales its vertical axis to whatever is in the lookahead window, because a
 * fixed scale would render a 20 m rise over 3 km as a flat line — invisible, and it is a real
 * climb. Auto-scaling means the *shape* can no longer be read as severity: a gentle drag and a
 * wall both fill the box. So severity moves to the colour channel, which is absolute, and the
 * shape carries the pattern — where the steps are, where it eases off.
 *
 * ## Why these bands
 *
 * They are the bands cyclists already think in, not an even split of the range. 3% is where a
 * road stops feeling flat, 6% is where most riders change gear and stop talking, 9% is where
 * standing up starts, 12% is where gearing becomes the question. An even split would put three
 * of its five bands above 12%, where almost no British road goes.
 *
 * Descents get one band and a cool colour. A rider needs to know a descent is *coming* — that
 * is the break — but not how steep it is in five gradations, and spending four more colours on
 * it would halve the resolution of the half of the scale that matters.
 *
 * These are chrome colours, drawn on a panel we control, so the C ≤ 15.4 stroke ceiling that
 * governs the basemap does not apply — that rule exists to stop a route line being mistaken
 * for a road, and nothing here is on the map.
 */

export interface GradeBand {
  /** Lower bound as a ratio; the band runs up to the next one. */
  from: number
  label: string
  colour: string
}

/*
 * Darkened where the light chrome needed it, and no further.
 *
 * These six were chosen against a slate panel, where the only constraint was "do not disappear
 * into the dark". The panel is white on the light theme, so the constraint now runs both ways
 * at once and the window is narrow: a bar has to clear 3:1 against `#ffffff` *and* against
 * `#11212d`, which confines every band to a relative luminance between about 0.14 and 0.30.
 *
 * Four of the six were already inside it. `rising` and `steep` were not — 2.27:1 and 2.84:1 on
 * white, a pale amber bar on a white card glanced at for under a second at 25 km/h in daylight
 * — and `downhill` had no headroom. Those three were pulled down to a target luminance with
 * their hue and saturation untouched; the other three are exactly as they were.
 *
 * The scale is read by **hue**, not by lightness, which is why flattening the arc costs
 * nothing: `flat` now sits between `rising` and `steep` in luminance and the three are still
 * obvious at a glance because one is grey, one is yellow and one is orange. What does have to
 * survive is the *severity* ramp — rising, steep, very steep, brutal darken in order — and the
 * separation of every adjacent pair. `chrome.test.ts` holds all three rules, so the next edit
 * cannot quietly trade one for another.
 */
export const GRADE_BANDS: GradeBand[] = [
  { from: -Infinity, label: 'downhill', colour: '#4899be' },
  { from: -0.01, label: 'flat', colour: '#7c8f96' },
  { from: 0.03, label: 'rising', colour: '#aa8f3e' },
  { from: 0.06, label: 'steep', colour: '#c47438' },
  { from: 0.09, label: 'very steep', colour: '#d2564c' },
  { from: 0.12, label: 'brutal', colour: '#b8467e' },
]

export function gradeBand(grade: number): GradeBand {
  let band = GRADE_BANDS[0]
  for (const candidate of GRADE_BANDS) {
    if (grade >= candidate.from) band = candidate
  }
  return band
}

export const gradeColour = (grade: number): string => gradeBand(grade).colour

/** `7%` / `−4%` / `flat`. Rounded, because a gradient quoted to a decimal place is noise. */
export function formatGrade(grade: number): string {
  const percent = grade * 100
  if (Math.abs(percent) < 1) return 'flat'
  // A true minus sign, not a hyphen: at 13px on a phone the hyphen is easy to miss, and
  // mistaking a descent for a climb is the one error this label can make.
  return `${percent < 0 ? '−' : ''}${Math.abs(percent).toFixed(0)}%`
}
