import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseBrouterGpx } from './gpx'
import { routeGeometry } from './progress'
import {
  CHAIN_WITHIN_M,
  MAX_LEAD_M,
  MIN_LEAD_M,
  isActionable,
  leadDistanceM,
  nextTurn,
  spokenTurn,
  turnExit,
  turnKind,
  turnLabel,
  turnToAnnounce,
  turnsAlong,
  type Turn,
} from './turns'

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), 'utf8')

const at = (atM: number, kind: Turn['kind'], exit: number | null = null): Turn => ({
  atM,
  kind,
  exit,
})

describe('turnKind', () => {
  it('reads every command BRouter emits on a British route', () => {
    expect(turnKind('TL')).toBe('left')
    expect(turnKind('TR')).toBe('right')
    expect(turnKind('TSLL')).toBe('slight-left')
    expect(turnKind('TSLR')).toBe('slight-right')
    expect(turnKind('TSHL')).toBe('sharp-left')
    expect(turnKind('TSHR')).toBe('sharp-right')
    expect(turnKind('KL')).toBe('keep-left')
    expect(turnKind('KR')).toBe('keep-right')
    expect(turnKind('C')).toBe('straight')
  })

  it('reads both roundabout handednesses', () => {
    // Britain's are all RNLB. RNDB exists for everywhere that drives on the right.
    expect(turnKind('RNLB2')).toBe('roundabout')
    expect(turnKind('RNDB3')).toBe('roundabout')
    expect(turnExit('RNLB2')).toBe(2)
    expect(turnExit('RNDB3')).toBe(3)
    expect(turnExit('TL')).toBeNull()
  })

  it('treats every U-turn token as one thing', () => {
    // getCommandString returns "TU" for TLU as well, with an upstream comment saying it
    // should be TLU and is waiting on a client. A rider does the same thing about either.
    expect(turnKind('TU')).toBe('u-turn')
    expect(turnKind('TLU')).toBe('u-turn')
    expect(turnKind('TRU')).toBe('u-turn')
  })

  it('reads the two tokens that only exist because the app asks for mode 9', () => {
    // `Formatter.getCommandString` spells EL and ER out at modes 2 and 9, and reports them as
    // KL and KR to every other client. Taking upstream's own fallback is not a guess, and
    // without it these junctions were dropped in silence by the one mode that emits them.
    expect(turnKind('EL')).toBe('keep-left')
    expect(turnKind('ER')).toBe('keep-right')
  })

  it('returns null for a token it has never seen rather than inventing one', () => {
    // Telling a rider to do something nobody decided on is worse than saying nothing. `OFFR`
    // is deliberately among these: it is BRouter reporting a state rather than asking for a
    // manoeuvre, and `cues.ts` owns off-route already.
    expect(turnKind('WAT')).toBeNull()
    expect(turnKind('OFFR')).toBeNull()
    expect(turnKind('')).toBeNull()
  })
})

describe('isActionable', () => {
  it('drops the three that ask for nothing', () => {
    // Straight on asks for no action; the finish is already counted down to and announced in
    // the app's own words; a beeline is BRouter reporting it gave up, not an instruction.
    expect(isActionable(at(0, 'straight'))).toBe(false)
    expect(isActionable(at(0, 'end'))).toBe(false)
    expect(isActionable(at(0, 'beeline'))).toBe(false)
    expect(isActionable(at(0, 'left'))).toBe(true)
    expect(isActionable(at(0, 'roundabout', 2))).toBe(true)
  })
})

describe('leadDistanceM', () => {
  it('gives fifteen seconds of warning at riding speed', () => {
    expect(leadDistanceM(25 / 3.6)).toBeCloseTo(104, 0)
  })

  it('floors it, so a slow rider still has room to act', () => {
    expect(leadDistanceM(1)).toBe(MIN_LEAD_M)
  })

  it('caps it, as a backstop rather than as something a bicycle reaches', () => {
    // The cap only binds above about 96 km/h, so no ride gets there. It exists for a fix
    // that is wrong but still inside the plausible band — following a train for a minute,
    // say — where the sanity check below would let it through.
    expect(leadDistanceM(29)).toBe(MAX_LEAD_M)
    // The fastest thing a rider actually does is nowhere near it.
    expect(leadDistanceM(60 / 3.6)).toBeLessThan(MAX_LEAD_M)
  })

  it('assumes a slow rider when the fix carries no speed', () => {
    // Early is recoverable and late is not, so the fallback is the slow end of riding.
    const guessed = leadDistanceM(null)
    expect(guessed).toBeLessThan(leadDistanceM(25 / 3.6))
    expect(guessed).toBeGreaterThanOrEqual(MIN_LEAD_M)
  })

  it('ignores a speed no bicycle produces', () => {
    // A stationary GPS reports drift, and a fix from a train reports 40 m/s.
    expect(leadDistanceM(0.1)).toBe(leadDistanceM(null))
    expect(leadDistanceM(40)).toBe(leadDistanceM(null))
  })
})

describe('nextTurn', () => {
  const turns = [at(100, 'straight'), at(200, 'left'), at(500, 'right')]

  it('finds the next one the rider has to do something about', () => {
    expect(nextTurn(turns, 0)).toEqual(at(200, 'left'))
    expect(nextTurn(turns, 250)).toEqual(at(500, 'right'))
  })

  it('returns null past the last one', () => {
    expect(nextTurn(turns, 600)).toBeNull()
  })

  it('never looks backwards', () => {
    // A turn at exactly the rider's position has been taken.
    expect(nextTurn([at(200, 'left')], 200)).toBeNull()
  })
})

describe('turnToAnnounce', () => {
  const speed = 25 / 3.6 // lead is ~104 m

  it('says nothing until the turn is inside the lead distance', () => {
    const turns = [at(500, 'left')]
    expect(turnToAnnounce(turns, 0, speed)).toBeNull()
    expect(turnToAnnounce(turns, 300, speed)).toBeNull()
    expect(turnToAnnounce(turns, 420, speed)?.turn.atM).toBe(500)
  })

  it('ignores a straight-on, however close', () => {
    expect(turnToAnnounce([at(50, 'straight')], 0, speed)).toBeNull()
  })

  it('chains a second turn that arrives on top of the first', () => {
    // A staggered crossroads. Announced separately the second utterance cancels the first —
    // useAnnouncer cancels rather than queues — and the rider hears half of each.
    const found = turnToAnnounce([at(100, 'left'), at(130, 'right')], 20, speed)
    expect(found?.turn.kind).toBe('left')
    expect(found?.then?.kind).toBe('right')
  })

  it('does not chain a turn that is a street away', () => {
    const found = turnToAnnounce(
      [at(100, 'left'), at(100 + CHAIN_WITHIN_M + 1, 'right')],
      20,
      speed,
    )
    expect(found?.then).toBeNull()
  })

  it('announces the turn in front, not the nearest', () => {
    // A rider stopped at a junction has a turn at 0 m behind them and one ahead. The one to
    // be told about is the one they have not done.
    const found = turnToAnnounce([at(10, 'left'), at(60, 'right')], 12, speed)
    expect(found?.turn.kind).toBe('right')
  })
})

describe('spokenTurn', () => {
  it('names the turn and how far off it is', () => {
    expect(spokenTurn(at(0, 'left'), null, '100 metres')).toBe('Left in 100 metres.')
    expect(spokenTurn(at(0, 'sharp-right'), null, '60 metres')).toBe('Sharp right in 60 metres.')
  })

  it('puts the exit number in, because it has to be known before entering', () => {
    expect(spokenTurn(at(0, 'roundabout', 3), null, '200 metres')).toBe(
      'Roundabout in 200 metres, 3rd exit.',
    )
  })

  it('chains without repeating the word turn', () => {
    // By the second clause the rider is already being told about turning, and the shorter
    // phrase is the one that survives a passing lorry.
    expect(spokenTurn(at(0, 'left'), at(0, 'right'), '100 metres')).toBe(
      'Left in 100 metres, then right.',
    )
  })

  it('never produces a decimal or a bare unit', () => {
    // spokenDistance exists because voices read "450 m" as "four hundred and fifty em".
    for (const kind of ['left', 'u-turn', 'keep-right'] as const) {
      expect(spokenTurn(at(0, kind), null, '1.2 kilometres')).not.toMatch(/\bm\b/)
    }
  })
})

describe('turnLabel', () => {
  it('fits one line on the strip', () => {
    expect(turnLabel(at(0, 'left'))).toBe('Left')
    expect(turnLabel(at(0, 'sharp-left'))).toBe('Sharp left')
    expect(turnLabel(at(0, 'roundabout', 2))).toBe('2nd exit')
    expect(turnLabel(at(0, 'roundabout', 4))).toBe('4th exit')
    for (const kind of ['left', 'keep-right', 'u-turn', 'slight-left'] as const) {
      expect(turnLabel(at(0, kind)).length).toBeLessThanOrEqual(11)
    }
  })

  it('defaults a roundabout with no exit to the first', () => {
    expect(turnLabel(at(0, 'roundabout'))).toBe('1st exit')
  })
})

describe('against a real route', () => {
  const long = parseBrouterGpx(fixture('london-brighton.gpx'))
  const geometry = routeGeometry(long)!
  const turns = turnsAlong(long, geometry)!

  it('reads every junction BRouter marked', () => {
    const symbols = fixture('london-brighton.gpx').match(/<sym>/g)!.length
    expect(turns).toHaveLength(symbols)
  })

  it('measures them along the route, in order', () => {
    const distances = turns.map((t) => t.atM)
    expect(distances).toEqual([...distances].sort((a, b) => a - b))
    expect(distances.at(-1)).toBeLessThanOrEqual(geometry.totalM)
  })

  it('leaves most of the junctions unspoken', () => {
    // 95 km with 322 junctions. The whole design of the cue rules is that a rider hears far
    // fewer than that, and this is the number that says whether it worked.
    const actionable = turns.filter(isActionable)
    expect(turns.length).toBeGreaterThan(300)
    expect(actionable.length).toBeLessThan(turns.length)
  })

  it('finds roundabouts with real exit numbers', () => {
    const roundabouts = turns.filter((t) => t.kind === 'roundabout')
    expect(roundabouts.length).toBeGreaterThan(0)
    for (const r of roundabouts) expect(r.exit).toBeGreaterThan(0)
  })

  it('is absent for a route with no turns at all', () => {
    const plain = parseBrouterGpx(fixture('urban-short-plain.gpx'))
    expect(turnsAlong(plain, routeGeometry(plain)!)).toBeNull()
  })
})
