import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { cueFor, spokenDistance, spokenGrade, type CueInput } from './cues'
import { gradients, type Gradient, type Severity } from './climbs'
import { routeGeometry } from './progress'
import { parseBrouterGpx } from './gpx'
import { turnsAlong } from './turns'

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), 'utf8')

function climb(startM: number, over: Partial<Gradient> = {}): Gradient {
  const lengthM = over.lengthM ?? 800
  const gainM = over.gainM ?? 48
  return {
    kind: 'climb',
    startM,
    endM: startM + lengthM,
    lengthM,
    gainM,
    grade: gainM / lengthM,
    maxGrade: gainM / lengthM,
    severity: 'moderate' as Severity,
    ...over,
  }
}

function descent(startM: number, lengthM: number): Gradient {
  return {
    kind: 'descent',
    startM,
    endM: startM + lengthM,
    lengthM,
    gainM: lengthM * 0.04,
    grade: 0.04,
    maxGrade: 0.06,
    severity: 'moderate',
  }
}

const base: CueInput = {
  alongM: 0,
  remainingM: 20_000,
  climbs: [],
  offRoute: false,
  offRouteSince: null,
  routeVersion: 1,
  turns: [],
  speedMps: 25 / 3.6,
}

const none = new Set<string>()

describe('cueFor', () => {
  it('says nothing when there is nothing to say', () => {
    expect(cueFor(base, none)).toBeNull()
  })

  it('announces a climb inside the approach window and not before', () => {
    const climbs = [climb(2000)]
    // 1.5 km away: too early to act on, and a rider told now will have forgotten by the foot.
    expect(cueFor({ ...base, climbs, alongM: 500 }, none)).toBeNull()
    const cue = cueFor({ ...base, climbs, alongM: 1500 }, none)!
    expect(cue.text).toContain('Climb in 500 metres')
    expect(cue.text).toContain('48 metres at 6 percent')
  })

  it('still announces a climb the rider sets off almost on top of', () => {
    // The route's first climb starts 200 m in. An earlier version had a 250 m lower bound on
    // the window and so never mentioned it — the one climb a rider is guaranteed to meet.
    expect(cueFor({ ...base, climbs: [climb(200)], alongM: 0 }, none)!.text).toContain('Climb in')
  })

  it('says nothing about a climb the rider is already on', () => {
    expect(cueFor({ ...base, climbs: [climb(2000)], alongM: 2400 }, none)).toBeNull()
  })

  it('says a climb once, however many fixes fall inside the window', () => {
    const climbs = [climb(2000)]
    const first = cueFor({ ...base, climbs, alongM: 1400 }, none)!
    const said = new Set([first.key])
    for (const alongM of [1420, 1500, 1600, 1740]) {
      expect(cueFor({ ...base, climbs, alongM }, said)).toBeNull()
    }
  })

  it('warns about a wall hidden inside a gentle average', () => {
    const cue = cueFor(
      { ...base, climbs: [climb(2000, { grade: 0.04, maxGrade: 0.12 })], alongM: 1500 },
      none,
    )!
    expect(cue.text).toContain('steepening to 12 percent')
  })

  it('does not qualify a climb whose steepest bit is its average', () => {
    const cue = cueFor({ ...base, climbs: [climb(2000)], alongM: 1500 }, none)!
    expect(cue.text).not.toContain('steepening')
  })

  it('ignores a rise too small to interrupt anyone for', () => {
    const bump = climb(2000, { gainM: 14, lengthM: 400 })
    expect(cueFor({ ...base, climbs: [bump], alongM: 1500 }, none)).toBeNull()
  })

  it('calls the top of a hard climb, and only a hard one', () => {
    const hard = climb(1000, { severity: 'hard' })
    expect(cueFor({ ...base, climbs: [hard], alongM: 1850 }, none)!.text).toBe('Top of the climb.')

    const easy = climb(1000, { severity: 'easy' })
    expect(cueFor({ ...base, climbs: [easy], alongM: 1850 }, none)).toBeNull()
  })

  it('stops calling the top once the rider is well past it', () => {
    const hard = climb(1000, { severity: 'hard' })
    expect(cueFor({ ...base, climbs: [hard], alongM: 3000 }, none)).toBeNull()
  })

  it('promises the rest before a long descent, but not a short one', () => {
    const long = cueFor({ ...base, climbs: [descent(2000, 1500)], alongM: 1500 }, none)!
    expect(long.text).toContain('Downhill in 500 metres')
    expect(long.text).toContain('1.5 kilometres')

    expect(cueFor({ ...base, climbs: [descent(2000, 300)], alongM: 1500 }, none)).toBeNull()
  })

  it('puts being off route ahead of everything else', () => {
    const cue = cueFor({ ...base, offRoute: true, climbs: [climb(2000)], alongM: 1500 }, none)!
    expect(cue.text).toBe('Off route.')
  })

  it('will say “off route” again after a reroute, but not before', () => {
    const off = { ...base, offRoute: true, offRouteSince: 1000 }
    const first = cueFor(off, none)!
    const said = new Set([first.key])
    expect(cueFor(off, said)).toBeNull()
    // A reroute bumps the version; leaving the *new* route is a new thing to say.
    expect(cueFor({ ...off, routeVersion: 2 }, said)!.text).toBe('Off route.')
  })

  it('says “off route” again on a second wrong turn on the same route', () => {
    // The case with automatic rerouting switched off: the geometry never changes, so keying
    // the cue to the route alone would meet the second wrong turn with silence.
    const first = cueFor({ ...base, offRoute: true, offRouteSince: 1000 }, none)!
    const said = new Set([first.key])
    // Back on the line: nothing to say.
    expect(cueFor({ ...base, offRouteSince: null }, said)).toBeNull()
    // And off it again, twenty minutes later.
    expect(cueFor({ ...base, offRoute: true, offRouteSince: 2200 }, said)!.text).toBe('Off route.')
  })

  it('counts the finish down and then announces it', () => {
    expect(cueFor({ ...base, remainingM: 400 }, none)!.text).toContain('Finish in 400 metres')
    expect(cueFor({ ...base, remainingM: 30 }, none)!.text).toBe('You have arrived.')
  })

  it('does not count down to a finish it has already announced', () => {
    // A fix that skips the whole 500–60 m window says only "arrived"; a rider who then drifts
    // back out to 400 m must not be told the finish is coming.
    const arrival = cueFor({ ...base, remainingM: 30 }, none)!
    const said = new Set([arrival.key])
    expect(cueFor({ ...base, remainingM: 400 }, said)).toBeNull()
    expect(cueFor({ ...base, remainingM: 30 }, said)).toBeNull()
  })

  it('counts down to the finish of a route that replaced one already arrived at', () => {
    const arrival = cueFor({ ...base, remainingM: 30 }, none)!
    const said = new Set([arrival.key])
    const rerouted = cueFor({ ...base, remainingM: 400, routeVersion: 2 }, said)!
    expect(rerouted.text).toContain('Finish in')
  })

  it('never says two things at once', () => {
    // A climb in the window, a descent in the window, and nearly home. Exactly one comes out.
    const cue = cueFor(
      {
        ...base,
        remainingM: 400,
        alongM: 1500,
        climbs: [climb(2000), descent(2100, 2000)],
      },
      none,
    )
    expect(cue).not.toBeNull()
    expect(typeof cue!.text).toBe('string')
  })

  it('keys a cue to the route it was about, so a reroute can say it again', () => {
    const climbs = [climb(2000)]
    const first = cueFor({ ...base, climbs, alongM: 1500 }, none)!
    expect(cueFor({ ...base, climbs, alongM: 1500, routeVersion: 2 }, new Set([first.key]))).not.toBeNull()
  })
})

describe('spokenDistance', () => {
  it('rounds hard, because a synthesiser reading “four hundred and thirty seven” is useless', () => {
    expect(spokenDistance(437)).toBe('450 metres')
    expect(spokenDistance(1240)).toBe('1.2 kilometres')
    expect(spokenDistance(23_400)).toBe('23 kilometres')
  })

  it('spells the unit out rather than leaving “m” to be read as “em”', () => {
    expect(spokenDistance(200)).toContain('metres')
    expect(spokenDistance(2000)).toContain('kilometres')
  })

  it('never says “0 metres”', () => {
    expect(spokenDistance(4)).toBe('50 metres')
  })
})

describe('spokenGrade', () => {
  it('is a whole number of percent, with no sign', () => {
    expect(spokenGrade(0.064)).toBe('6 percent')
    expect(spokenGrade(-0.087)).toBe('9 percent')
  })
})

describe('a whole ride, cue by cue', () => {
  // Walked over a real 95 km route rather than a synthetic one, because the thing most likely
  // to go wrong is not a single rule but their interaction over a long ride: a cue repeating
  // every fix, or a cue that never fires because another one always wins.
  const route = parseBrouterGpx(fixture('london-brighton.gpx'))
  const geometry = routeGeometry(route)!
  const climbs = gradients(geometry)
  const turns = turnsAlong(route, geometry)!

  const spoken: string[] = []
  const keys: string[] = []
  const said = new Set<string>()
  for (let alongM = 0; alongM <= geometry.totalM; alongM += 25) {
    const cue = cueFor(
      {
        alongM,
        remainingM: geometry.totalM - alongM,
        climbs,
        offRoute: false,
        offRouteSince: null,
        routeVersion: 1,
        turns,
        speedMps: 25 / 3.6,
      },
      said,
    )
    if (cue) {
      said.add(cue.key)
      keys.push(cue.key)
      spoken.push(cue.text)
    }
  }

  const turnCues = spoken.filter((t) => !t.startsWith('Climb') && !t.startsWith('Downhill'))

  it('speaks each junction once and only once', () => {
    // Keys, not text. Two junctions a mile apart both produce "Left in 100 metres", and that
    // is correct — `Cue.key` identifies the event and the words are just the words.
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('keeps the whole ride well under one utterance a minute', () => {
    // 3,800 fixes' worth of positions over about four hours. 322 junctions announced the way
    // a car satnav does them would be 644 utterances; the rules in `turns.ts` are what stand
    // between that and an app the rider mutes in the first hour.
    //
    // The bound is what makes this a test rather than a demonstration. Four hours at one a
    // minute is 240, and anything approaching that is a failure however sensible each
    // individual cue looked.
    expect(spoken.length).toBeGreaterThan(20)
    expect(spoken.length).toBeLessThan(180)
  })

  it('speaks well under half the junctions on the route', () => {
    // Most of the saving is dropping the slight turns, then `C`, then chaining. If this ever
    // creeps towards 1:1 something has stopped collapsing and the ride is a monologue.
    expect(turnCues.length).toBeLessThan(turns.length / 2)
  })

  it('chains at least one pair, because a route this long has staggered junctions', () => {
    expect(spoken.some((t) => t.includes(', then '))).toBe(true)
  })

  it('names the roundabout exits it meets', () => {
    expect(spoken.some((t) => /Roundabout in .*, \d(st|nd|rd|th) exit/.test(t))).toBe(true)
  })

  it('ends with arrival, having counted down to it', () => {
    // Not adjacent any more, and that is right: the finish is announced at 500 m and a
    // junction inside that is still a junction the rider has to take.
    expect(spoken[spoken.length - 1]).toBe('You have arrived.')
    expect(spoken.filter((t) => t.startsWith('Finish in'))).toHaveLength(1)
  })

  it('announces the climbs that matter and nothing that does not', () => {
    const climbCues = spoken.filter((t) => t.startsWith('Climb in'))
    expect(climbCues.length).toBeGreaterThan(2)
    for (const text of climbCues) {
      expect(text).toMatch(/^Climb in [\d.]+ (metres|kilometres)\. \d+ metres at \d+ percent/)
    }
  })

  it('promises a rest at least once on a route with 900 m of descending', () => {
    expect(spoken.some((t) => t.startsWith('Downhill in'))).toBe(true)
  })
})
