/**
 * Who is riding, and on what.
 *
 * Four numbers decide every physical estimate the app makes: total mass, drag area, rolling
 * resistance, and — implicitly — how honest the rider is about the first one. Mass is asked
 * for directly because it is the input a rider actually knows. The other two are chosen from
 * pictures of situations rather than typed in, because nobody knows their CdA and a text field
 * asking for it is a text field that will be left at its default forever.
 *
 * Kept out of the plan (`plan.ts`) deliberately: a plan is a route and changes constantly, and
 * this is a property of the rider that changes about once a year.
 */

export interface RiderSetup {
  riderKg: number
  /** Bike, and anything strapped to it. Panniers belong here, not in `riderKg`. */
  bikeKg: number
  position: PositionId
  tyres: TyreId
}

/**
 * Drag area by riding position, m².
 *
 * Published wind-tunnel figures for a ~1.8 m rider. The spread between the extremes is more
 * than two to one, which is why this is asked at all: getting it wrong is the single largest
 * error in the flat-ground estimate. It barely matters on a climb.
 */
export const POSITIONS = [
  { id: 'upright', label: 'Upright', note: 'Hybrid, town bike, hands on flat bars', cdaM2: 0.55 },
  { id: 'hoods', label: 'On the hoods', note: 'Drop bars, the usual position', cdaM2: 0.4 },
  { id: 'drops', label: 'In the drops', note: 'Low and tucked', cdaM2: 0.32 },
  { id: 'loaded', label: 'Loaded tourer', note: 'Bags, and the wind knows it', cdaM2: 0.65 },
] as const

/**
 * Rolling resistance by tyre, dimensionless.
 *
 * The range here is nearly four to one, and unlike drag it applies at every speed — which is
 * why a knobbly tyre feels slow even freewheeling. Figures are for a typical tyre of each kind
 * on tarmac at sensible pressure; off tarmac they all get worse and none of this is precise.
 */
export const TYRES = [
  { id: 'road', label: 'Road', note: 'Slick, 25–32 mm', crr: 0.005 },
  { id: 'allroad', label: 'All-road', note: 'Light tread, 32–40 mm', crr: 0.0075 },
  { id: 'gravel', label: 'Gravel', note: 'Knobbly, 40 mm and up', crr: 0.011 },
  { id: 'mtb', label: 'Mountain bike', note: 'Big and soft', crr: 0.016 },
] as const

export type PositionId = (typeof POSITIONS)[number]['id']
export type TyreId = (typeof TYRES)[number]['id']

/**
 * The default rider.
 *
 * A 75 kg rider on a 10 kg bike with 32 mm tyres on the hoods — near the middle of everything,
 * so a rider who never opens the settings gets an estimate that is wrong by a sensible amount
 * rather than by a factor of two.
 */
export const DEFAULT_RIDER: RiderSetup = {
  riderKg: 75,
  bikeKg: 10,
  position: 'hoods',
  tyres: 'allroad',
}

/** Sanity bounds. Not validation for its own sake — a zero mass divides the model by zero. */
const MASS_LIMITS = { riderKg: [30, 200], bikeKg: [3, 60] } as const

export const totalMassKg = (setup: RiderSetup) => setup.riderKg + setup.bikeKg
export const cdaOf = (setup: RiderSetup) =>
  (POSITIONS.find((p) => p.id === setup.position) ?? POSITIONS[1]).cdaM2
export const crrOf = (setup: RiderSetup) =>
  (TYRES.find((t) => t.id === setup.tyres) ?? TYRES[1]).crr

const STORAGE_KEY = 'free-wheel.rider.v1'

/**
 * Turns whatever is on disk into a usable rider.
 *
 * Field by field rather than all-or-nothing, unlike `migratePlan`. A plan is one object the
 * rider built in one sitting, so a corrupt one is best discarded whole; this is four
 * independent settings, and throwing away a correct mass because a tyre id was renamed would
 * be gratuitous.
 */
export function migrateRider(raw: unknown): RiderSetup {
  if (!raw || typeof raw !== 'object') return DEFAULT_RIDER
  const stored = raw as Partial<RiderSetup>
  return {
    riderKg: number(stored.riderKg, DEFAULT_RIDER.riderKg, MASS_LIMITS.riderKg),
    bikeKg: number(stored.bikeKg, DEFAULT_RIDER.bikeKg, MASS_LIMITS.bikeKg),
    position: POSITIONS.some((p) => p.id === stored.position)
      ? (stored.position as PositionId)
      : DEFAULT_RIDER.position,
    tyres: TYRES.some((t) => t.id === stored.tyres)
      ? (stored.tyres as TyreId)
      : DEFAULT_RIDER.tyres,
  }
}

function number(value: unknown, fallback: number, [low, high]: readonly [number, number]): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(value, low), high)
}

export function loadRider(): RiderSetup {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return migrateRider(raw ? JSON.parse(raw) : null)
  } catch {
    return DEFAULT_RIDER
  }
}

export function saveRider(setup: RiderSetup): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(setup))
  } catch {
    // Private browsing. The rider retypes their weight next launch, which is annoying and
    // not worth failing a ride over.
  }
}
