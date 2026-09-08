import { describe, expect, it } from 'vitest'
import { formatAway, formatElapsed, formatPower, formatSpeed } from './format'
import { formatGrade, gradeBand, gradeColour, GRADE_BANDS } from './gradeScale'

describe('formatElapsed', () => {
  it('reads like a stopwatch', () => {
    expect(formatElapsed(0)).toBe('0:00')
    expect(formatElapsed(65)).toBe('1:05')
    expect(formatElapsed(3600)).toBe('1:00:00')
    expect(formatElapsed(4040)).toBe('1:07:20')
  })

  it('does not show a negative clock', () => {
    expect(formatElapsed(-5)).toBe('0:00')
  })
})

describe('formatSpeed', () => {
  it('converts to km/h with one decimal', () => {
    expect(formatSpeed(8.3333)).toBe('30.0')
  })

  it('says nothing rather than zero when there is no fix', () => {
    expect(formatSpeed(null)).toBe('—')
    expect(formatSpeed(NaN)).toBe('—')
  })
})

describe('formatPower', () => {
  it('rounds to five, because the estimate is not accurate to one', () => {
    expect(formatPower(217)).toBe('215')
    expect(formatPower(218)).toBe('220')
  })

  it('says nothing rather than zero when there is no estimate', () => {
    expect(formatPower(null)).toBe('—')
  })

  it('does show a real zero, which is what freewheeling is', () => {
    expect(formatPower(0)).toBe('0')
  })
})

describe('formatAway', () => {
  it('rounds a countdown coarser the further away it is', () => {
    expect(formatAway(42)).toBe('40 m')
    expect(formatAway(430)).toBe('450 m')
    expect(formatAway(1240)).toBe('1.2 km')
    expect(formatAway(23_400)).toBe('23 km')
  })
})

describe('gradeBand', () => {
  it('puts each gradient in the band a cyclist would name', () => {
    expect(gradeBand(-0.07).label).toBe('downhill')
    expect(gradeBand(0).label).toBe('flat')
    expect(gradeBand(0.04).label).toBe('rising')
    expect(gradeBand(0.07).label).toBe('steep')
    expect(gradeBand(0.1).label).toBe('very steep')
    expect(gradeBand(0.18).label).toBe('brutal')
  })

  it('is defined for every gradient, including absurd ones', () => {
    for (const grade of [-10, -0.5, 0, 0.5, 10]) {
      expect(gradeColour(grade)).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('has bands in ascending order, so the lookup cannot silently invert', () => {
    for (let i = 1; i < GRADE_BANDS.length; i++) {
      expect(GRADE_BANDS[i].from).toBeGreaterThan(GRADE_BANDS[i - 1].from)
    }
  })
})

describe('formatGrade', () => {
  it('marks a descent with a true minus sign, not a hyphen', () => {
    expect(formatGrade(-0.043)).toBe('−4%')
    expect(formatGrade(-0.043)).not.toContain('-')
  })

  it('calls a fraction of a percent flat rather than 0%', () => {
    expect(formatGrade(0.004)).toBe('flat')
    expect(formatGrade(-0.004)).toBe('flat')
  })

  it('rounds, because a gradient quoted to a decimal is noise', () => {
    expect(formatGrade(0.0731)).toBe('7%')
  })
})
