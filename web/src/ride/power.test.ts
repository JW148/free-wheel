import { describe, expect, it } from 'vitest'
import { airDensity, estimatePowerW, ewma, kilocaloriesFrom } from './power'
import { cdaOf, crrOf, DEFAULT_RIDER, migrateRider, totalMassKg } from './rider'

/** 75 kg rider, 8 kg bike, in the drops, on good road tyres. */
const base = { massKg: 83, cdaM2: 0.32, crr: 0.005 }
const kmh = (v: number) => v / 3.6

describe('estimatePowerW', () => {
  it('agrees with the textbook figure on the flat', () => {
    // Worked by hand: rolling 4.07 N + drag 13.61 N over 8.333 m/s is 147.3 W at the wheel,
    // 151.9 W at the pedals through a 97% drivetrain.
    expect(estimatePowerW({ ...base, speedMps: kmh(30), grade: 0 })).toBeCloseTo(151.9, 0)
  })

  it('agrees with the textbook figure on a climb', () => {
    // 15 km/h up 8%: gravity 64.9 N dominates, and the answer is a number a club rider would
    // recognise as "the top of my endurance zone".
    const watts = estimatePowerW({ ...base, speedMps: kmh(15), grade: 0.08 })
    expect(watts).toBeGreaterThan(295)
    expect(watts).toBeLessThan(320)
  })

  it('reports nothing rather than a negative number when gravity is doing the work', () => {
    expect(estimatePowerW({ ...base, speedMps: kmh(45), grade: -0.08 })).toBe(0)
  })

  it('reports nothing at a standstill', () => {
    expect(estimatePowerW({ ...base, speedMps: 0, grade: 0.08 })).toBe(0)
    expect(estimatePowerW({ ...base, speedMps: -1, grade: 0 })).toBe(0)
  })

  it('goes as the cube of speed once drag dominates', () => {
    // Doubling 30 to 60 km/h should roughly quadruple the drag *force* and so multiply the
    // drag power by eight. Rolling resistance keeps it under that, hence the loose bounds.
    const slow = estimatePowerW({ ...base, speedMps: kmh(30), grade: 0 })
    const fast = estimatePowerW({ ...base, speedMps: kmh(60), grade: 0 })
    expect(fast / slow).toBeGreaterThan(5)
    expect(fast / slow).toBeLessThan(8)
  })

  it('scales the climbing term with mass, which is why the setting matters', () => {
    const light = estimatePowerW({ ...base, massKg: 70, speedMps: kmh(12), grade: 0.1 })
    const heavy = estimatePowerW({ ...base, massKg: 95, speedMps: kmh(12), grade: 0.1 })
    expect(heavy / light).toBeCloseTo(95 / 70, 1)
  })

  it('barely notices the aero setting on a steep climb, and cares a lot on the flat', () => {
    const climbing = [0.32, 0.65].map((cdaM2) =>
      estimatePowerW({ ...base, cdaM2, speedMps: kmh(12), grade: 0.08 }),
    )
    const flat = [0.32, 0.65].map((cdaM2) =>
      estimatePowerW({ ...base, cdaM2, speedMps: kmh(32), grade: 0 }),
    )
    expect(climbing[1] / climbing[0]).toBeLessThan(1.05)
    expect(flat[1] / flat[0]).toBeGreaterThan(1.6)
  })

  it('treats a headwind as speed the rider does not get credit for', () => {
    const still = estimatePowerW({ ...base, speedMps: kmh(30), grade: 0 })
    const headwind = estimatePowerW({ ...base, speedMps: kmh(30), grade: 0, windMps: 5 })
    const tailwind = estimatePowerW({ ...base, speedMps: kmh(30), grade: 0, windMps: -5 })
    expect(headwind).toBeGreaterThan(still)
    expect(tailwind).toBeLessThan(still)
  })

  it('lets a tailwind stronger than the rider push rather than resist', () => {
    // Signed drag. Squaring without the sign would turn a 12 m/s tailwind at 8 m/s into a
    // headwind, and report a rider being blown along as working hard. The tyres still have to
    // be turned, so the answer is small rather than zero — and crucially it is *below* what
    // rolling resistance alone would cost, because the air is helping.
    const blown = estimatePowerW({ ...base, speedMps: kmh(30), grade: 0, windMps: -12 })
    const rollingOnly = estimatePowerW({ ...base, cdaM2: 0, speedMps: kmh(30), grade: 0 })
    expect(blown).toBeGreaterThan(0)
    expect(blown).toBeLessThan(rollingOnly)
  })

  it('charges for acceleration', () => {
    const steady = estimatePowerW({ ...base, speedMps: kmh(25), grade: 0 })
    const sprinting = estimatePowerW({ ...base, speedMps: kmh(25), grade: 0, accelMps2: 0.5 })
    expect(sprinting - steady).toBeCloseTo((83 * 0.5 * kmh(25)) / 0.97, 0)
  })

  it('uses the exact slope rather than treating the gradient as a sine', () => {
    // At 20% the two differ by 2%. Small, but free to get right.
    const watts = estimatePowerW({ ...base, speedMps: kmh(8), grade: 0.2, crr: 0, cdaM2: 0 })
    const naive = (83 * 9.80665 * 0.2 * kmh(8)) / 0.97
    expect(watts).toBeLessThan(naive)
    expect(watts).toBeGreaterThan(naive * 0.97)
  })
})

describe('airDensity', () => {
  it('is 1.225 at sea level and thinner up high', () => {
    expect(airDensity(0)).toBeCloseTo(1.225, 3)
    expect(airDensity(1000)).toBeCloseTo(1.112, 2)
    expect(airDensity(2000)).toBeLessThan(airDensity(1000))
  })

  it('survives a nonsense height rather than returning NaN', () => {
    expect(Number.isFinite(airDensity(-40_000))).toBe(true)
    expect(Number.isFinite(airDensity(1e9))).toBe(true)
  })

  it('makes the same effort go further up a mountain', () => {
    const sea = estimatePowerW({ ...base, speedMps: kmh(40), grade: 0 })
    const high = estimatePowerW({
      ...base,
      speedMps: kmh(40),
      grade: 0,
      rhoKgM3: airDensity(2000),
    })
    expect(high).toBeLessThan(sea * 0.85)
  })
})

describe('ewma', () => {
  it('takes the first sample whole', () => {
    expect(ewma(null, 250, 1, 8)).toBe(250)
  })

  it('smooths the same amount over the same time however the fixes fall', () => {
    // Six one-second fixes against three two-second fixes. A fixed per-sample weight would
    // give these two very different answers, which is the bug this signature exists to avoid.
    let perSecond: number | null = 100
    for (let i = 0; i < 6; i++) perSecond = ewma(perSecond, 300, 1, 8)
    let perTwo: number | null = 100
    for (let i = 0; i < 3; i++) perTwo = ewma(perTwo, 300, 2, 8)
    expect(perSecond!).toBeCloseTo(perTwo!, 6)
  })

  it('converges on a steady input', () => {
    let value: number | null = 0
    for (let i = 0; i < 200; i++) value = ewma(value, 220, 1, 8)
    expect(value!).toBeCloseTo(220, 3)
  })

  it('passes a sample straight through when time has not moved', () => {
    expect(ewma(100, 300, 0, 8)).toBe(300)
  })
})

describe('kilocaloriesFrom', () => {
  it('is very nearly one for one with kilojoules, which is not a coincidence worth hiding', () => {
    expect(kilocaloriesFrom(1000)).toBeCloseTo(996, 0)
  })
})

describe('migrateRider', () => {
  it('hands back the default when there is nothing stored', () => {
    expect(migrateRider(null)).toEqual(DEFAULT_RIDER)
    expect(migrateRider('nonsense')).toEqual(DEFAULT_RIDER)
  })

  it('keeps the fields it understands and defaults the ones it does not', () => {
    const restored = migrateRider({ riderKg: 92, position: 'was-removed', tyres: 'gravel' })
    expect(restored.riderKg).toBe(92)
    expect(restored.tyres).toBe('gravel')
    expect(restored.position).toBe(DEFAULT_RIDER.position)
    expect(restored.bikeKg).toBe(DEFAULT_RIDER.bikeKg)
  })

  it('clamps a mass that would divide the model by zero', () => {
    expect(migrateRider({ riderKg: 0 }).riderKg).toBeGreaterThan(0)
    expect(migrateRider({ bikeKg: -5 }).bikeKg).toBeGreaterThan(0)
    expect(migrateRider({ riderKg: NaN }).riderKg).toBe(DEFAULT_RIDER.riderKg)
  })

  it('derives a usable set of physical constants', () => {
    const setup = migrateRider({ riderKg: 80, bikeKg: 9, position: 'drops', tyres: 'road' })
    expect(totalMassKg(setup)).toBe(89)
    expect(cdaOf(setup)).toBe(0.32)
    expect(crrOf(setup)).toBe(0.005)
  })
})
