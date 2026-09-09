/**
 * What the rider is putting through the pedals, from speed and gradient.
 *
 * ## Why this is worth doing without a power meter
 *
 * Everything in the standard cycling power equation is either known (mass, air density from
 * height) or already on screen (speed from GPS, gradient from the route's own elevation
 * profile). The one genuinely uncertain input is CdA, and it is uncertain by maybe ±15% —
 * which puts the estimate within a rough band of the truth on a climb, where gravity dominates
 * and CdA barely matters, and within a wider one on the flat, where it does.
 *
 * That asymmetry is the feature. Climbing is exactly when a rider wants to know whether they
 * are going too hard, and climbing is exactly where this model is most trustworthy: at 15 km/h
 * up 8%, gravity is 90% of the resistance and the aero guess is nearly irrelevant.
 *
 * ## Where the gradient comes from, and why not from GPS
 *
 * From the *route*, via `gradeAt`. GPS altitude is the worst channel a phone has — tens of
 * metres of error, drifting — so differentiating it produces gradients that swing through ±20%
 * standing still. The route's elevations came from SRTM through BRouter, are smoothed over
 * 120 m, and do not move when the rider does. The cost is that the number is only meaningful
 * while on the route, which is exactly when it is shown.
 *
 * ## What it is not
 *
 * Not a power meter, and the UI must never imply it is. It cannot see wind, a rucksack, wet
 * roads, or brakes being dragged on a descent. It is an *estimate*, and it is labelled as one.
 */

/** Standard gravity, m/s². */
const G = 9.80665

/** Chain, jockey wheels and bearings. 97% is the usual figure for a clean drivetrain. */
const DEFAULT_DRIVETRAIN = 0.97

export interface PowerInput {
  speedMps: number
  /** Gradient as a ratio: 0.08 is 8% up, -0.08 is 8% down. */
  grade: number
  /** Rider plus bike plus everything they are carrying, kg. */
  massKg: number
  /** Drag area — drag coefficient times frontal area — in m². */
  cdaM2: number
  /** Coefficient of rolling resistance. */
  crr: number
  /** kg/m³. Defaults to sea level; pass {@link airDensity} for anything high. */
  rhoKgM3?: number
  /** Headwind component along the direction of travel, m/s. Positive is a headwind. */
  windMps?: number
  /** m/s². Included because a sprint out of a junction is real work. */
  accelMps2?: number
  drivetrain?: number
}

/**
 * Watts at the pedals, or zero when the rider is not driving the bike.
 *
 * Freewheeling downhill produces a *negative* sum of forces — gravity is doing the work — and
 * the honest answer there is zero, not a negative number. A rider sees 0 W on a descent and
 * understands it immediately; a rider seeing −180 W does not.
 */
export function estimatePowerW(input: PowerInput): number {
  const {
    speedMps,
    grade,
    massKg,
    cdaM2,
    crr,
    rhoKgM3 = 1.225,
    windMps = 0,
    accelMps2 = 0,
    drivetrain = DEFAULT_DRIVETRAIN,
  } = input

  if (!(speedMps > 0)) return 0

  // Resolve the slope properly rather than treating the gradient as the sine. At 20% the
  // difference is 2%, which is small — but the exact form costs one square root.
  const hypotenuse = Math.sqrt(1 + grade * grade)
  const sin = grade / hypotenuse
  const cos = 1 / hypotenuse

  const gravity = massKg * G * sin
  const rolling = crr * massKg * G * cos
  const air = airResistanceN(speedMps + windMps, rhoKgM3, cdaM2)
  const acceleration = massKg * accelMps2

  const atTheWheel = (gravity + rolling + air + acceleration) * speedMps
  return atTheWheel <= 0 ? 0 : atTheWheel / drivetrain
}

/** Signed, so a tailwind stronger than the rider's speed pushes rather than resists. */
function airResistanceN(apparentMps: number, rho: number, cdaM2: number): number {
  return 0.5 * rho * cdaM2 * apparentMps * Math.abs(apparentMps)
}

/**
 * Air density at a height, from the International Standard Atmosphere.
 *
 * Worth including for one reason: the same effort goes measurably further up high, and a rider
 * who has just climbed 800 m is going noticeably faster on the descent than the sea-level
 * figure predicts. About 9% less dense at 1,000 m.
 */
export function airDensity(elevM: number): number {
  // Valid through the troposphere, which comfortably covers anywhere a bicycle goes.
  const clamped = Math.max(-500, Math.min(elevM, 11_000))
  return 1.225 * Math.pow(1 - 2.25577e-5 * clamped, 4.25588)
}

/**
 * An exponential moving average with a time constant in seconds, robust to uneven sampling.
 *
 * Fixes are not evenly spaced — iOS delivers them when it has one — so a fixed per-sample
 * weight makes the smoothing tighter or looser depending on how well the phone can see the
 * sky. Deriving the weight from the elapsed time gives the same smoothing either way.
 *
 * Used on power rather than on speed. Smoothing speed would also smooth the distance and the
 * ETA, which should track the fixes exactly; power is the only figure that is unreadable
 * unsmoothed, because it goes as the *cube* of speed and so triples on a 40% speed spike.
 */
export function ewma(
  previous: number | null,
  sample: number,
  dtS: number,
  tauS: number,
): number {
  if (previous === null || !(dtS > 0) || !(tauS > 0)) return sample
  const weight = 1 - Math.exp(-dtS / tauS)
  return previous + weight * (sample - previous)
}

/**
 * Food, from work done.
 *
 * A cyclist converts roughly 24% of their metabolic energy into work at the pedals, and a
 * dietary Calorie is 4.184 kJ. Those two numbers very nearly cancel — 1 / (4.184 × 0.24) =
 * 0.996 — so kilojoules at the pedals and Calories burned are the same number to within half a
 * percent. That is not a coincidence anyone planned, but it is why every bike computer quotes
 * both and they always match.
 */
export function kilocaloriesFrom(kilojoules: number): number {
  return kilojoules * 0.996
}
