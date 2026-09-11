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

export const GRADE_BANDS: GradeBand[] = [
  { from: -Infinity, label: 'downhill', colour: '#4a9ec4' },
  { from: -0.01, label: 'flat', colour: '#7c8f96' },
  { from: 0.03, label: 'rising', colour: '#c8a94b' },
  { from: 0.06, label: 'steep', colour: '#dd8340' },
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
