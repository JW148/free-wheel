import type { ParsedRoute } from './gpx'
import type { RouteGeometry } from './progress'

/**
 * Where to turn, and when to say so.
 *
 * ## Where this comes from
 *
 * BRouter computes a voice hint at every junction of every route, and has done all along. Mode
 * 9 writes the command onto the track point as a `<sym>`; `gpx.ts` reads it. Nothing here asks
 * the engine for anything it was not already working out.
 *
 * There are **no street names**, and there will not be from this data. `lookups.dat` has no
 * `name` key, so the `.rd5` tiles do not carry one. Every instruction is "left in 200 metres"
 * and never "left onto Mill Lane". The basemap archive does have road names, so a name could
 * be recovered at a turn's coordinate later — a lookup at a known point rather than a
 * geocoder, which is a different thing from the one the app has refused to grow.
 *
 * ## Why one utterance per turn
 *
 * `cues.ts` sets the bar: a cue earns its place by changing what the rider does in the next
 * minute, and an app that talks constantly gets muted, and a muted app says nothing at all.
 * Turns strain that harder than anything else on the list, because there are so many of them —
 * the London to Brighton reference route has 322 junctions over 95 km, and 37 of those are a
 * `C` telling the rider to ignore a turning.
 *
 * So: one utterance per turn, not a "prepare" and a "now". Timed rather than spaced, because a
 * fixed distance is too early in traffic and too late on a descent. Chained when two turns
 * arrive together, which is the collapse every satnav makes and the only thing that stops a
 * staggered crossroads becoming two interruptions on top of each other. And `C` is dropped
 * entirely — the parser keeps it, because throwing data away at the boundary forecloses a
 * later decision, and nothing downstream shows it.
 */

export type TurnKind =
  | 'left'
  | 'slight-left'
  | 'sharp-left'
  | 'keep-left'
  | 'right'
  | 'slight-right'
  | 'sharp-right'
  | 'keep-right'
  | 'u-turn'
  | 'roundabout'
  | 'straight'
  | 'end'
  | 'beeline'

export interface Turn {
  /** Distance along the route, metres. */
  atM: number
  kind: TurnKind
  /** Which exit off a roundabout, when {@link kind} is `roundabout`. Null otherwise. */
  exit: number | null
}

/**
 * BRouter's tokens.
 *
 * `TLU` and `TU` both come back as `TU` from `getCommandString` — upstream's own comment says
 * it should be `TLU` and is kept for a client that has not caught up — so both are read as a
 * U-turn here, which is what a rider does about either.
 */
const KINDS: Record<string, TurnKind> = {
  TL: 'left',
  TSLL: 'slight-left',
  TSHL: 'sharp-left',
  KL: 'keep-left',
  TR: 'right',
  TSLR: 'slight-right',
  TSHR: 'sharp-right',
  KR: 'keep-right',
  TU: 'u-turn',
  TLU: 'u-turn',
  TRU: 'u-turn',
  C: 'straight',
  BL: 'beeline',
  END: 'end',
}

/** `RNDB3` clockwise, `RNLB2` anticlockwise — Britain's are all the latter. */
const ROUNDABOUT = /^RN[DL]B(\d+)$/

export function turnKind(command: string): TurnKind | null {
  if (ROUNDABOUT.test(command)) return 'roundabout'
  return KINDS[command] ?? null
}

export function turnExit(command: string): number | null {
  const match = ROUNDABOUT.exec(command)
  return match ? Number(match[1]) : null
}

const turnCache = new WeakMap<ParsedRoute, Turn[] | null>()

/**
 * The junctions, measured along the route.
 *
 * Measured against `routeGeometry` rather than BRouter's own distances, for the reason
 * `ways.ts` gives: this has to agree with `snapToRoute` and with the progress bar, which is
 * what decides how far away a turn is. Cached per route, like everything else built off one.
 *
 * A command the table has never heard of is dropped rather than guessed at. The alternative is
 * telling a rider to do something nobody decided on.
 */
export function turnsAlong(route: ParsedRoute, geometry: RouteGeometry): Turn[] | null {
  const cached = turnCache.get(route)
  if (cached !== undefined) return cached

  const built = route.turns
    ? route.turns
        .map((turn) => {
          const kind = turnKind(turn.command)
          if (kind === null) return null
          return {
            atM: geometry.cumulativeM[Math.min(turn.index, geometry.cumulativeM.length - 1)],
            kind,
            exit: turnExit(turn.command),
          }
        })
        .filter((turn): turn is Turn => turn !== null)
    : null

  const result = built && built.length > 0 ? built : null
  turnCache.set(route, result)
  return result
}

/**
 * The turns worth putting on screen: everything but going straight on and arriving.
 *
 * `straight` asks for no action. `end` is the finish, which `cues.ts` already counts down to
 * and announces in its own words — said twice it would be the app repeating itself at the one
 * moment the rider is certain what is happening. `beeline` is BRouter reporting that it gave
 * up and drew a straight line, which is a fact about the route rather than an instruction.
 */
export const isActionable = (turn: Turn): boolean =>
  turn.kind !== 'straight' && turn.kind !== 'end' && turn.kind !== 'beeline'

/**
 * The turns worth *interrupting* for, which is a smaller set than the ones worth showing.
 *
 * Slight turns are dropped, and this is the single biggest thing keeping the app quiet. On the
 * London to Brighton route they are 125 of the 285 actionable junctions — 44% — and most of
 * them are a road bending where another road happens to join. BRouter is right to emit them,
 * because a decision technically exists; a rider following a road round a curve does not need
 * to be told to follow the road round a curve.
 *
 * With them, that route produced 267 utterances over about four hours, one every 54 seconds.
 * That is the failure mode `cues.ts` names at the top: an app that talks constantly gets
 * muted, and a muted app says nothing at all, including the things that mattered.
 *
 * The same argument the climb rules already make. "Top of the climb" is spoken only for a
 * climb hard enough that the rider was rationing, because being told you have crested a
 * railway bridge is what gets an app muted.
 *
 * Two things make this safe rather than merely quieter. A slight turn is still **drawn** —
 * `isActionable` is what the strip reads, so it is on screen with its distance. And it still
 * **chains**: "left, then bear right" costs no extra interruption, and a fork immediately
 * after a real turn is exactly where a rider would otherwise go wrong. Past both of those,
 * the off-route cue is the net.
 */
export const isSpoken = (turn: Turn): boolean =>
  isActionable(turn) && turn.kind !== 'slight-left' && turn.kind !== 'slight-right'

/** The next turn strictly ahead of the rider, or null past the last one. */
export function nextTurn(turns: Turn[], alongM: number): Turn | null {
  for (const turn of turns) {
    if (turn.atM > alongM && isActionable(turn)) return turn
  }
  return null
}

/**
 * How far ahead to speak, from how fast the rider is going.
 *
 * Fifteen seconds, which at 25 km/h is about 100 m and at walking pace is about 60. A fixed
 * distance cannot do both: 200 m is two streets early in town and arrives after the junction
 * at 50 km/h down a hill.
 *
 * Floored at 60 m because below that there is no time to act on it. The 400 m cap only binds
 * above about 96 km/h, so no ride reaches it: it is a backstop for a fix that is wrong but
 * still inside the plausible band, not a normal path.
 *
 * A missing or nonsensical speed falls back to 15 km/h, which is the slow end of riding rather
 * than the fast end — early is recoverable, late is not.
 */
export const LEAD_SECONDS = 15
export const MIN_LEAD_M = 60
export const MAX_LEAD_M = 400

export function leadDistanceM(speedMps: number | null): number {
  const speed = speedMps !== null && speedMps > 0.5 && speedMps < 30 ? speedMps : 15 / 3.6
  return Math.min(MAX_LEAD_M, Math.max(MIN_LEAD_M, speed * LEAD_SECONDS))
}

/**
 * How close a second turn has to be before it is folded into the first one's sentence.
 *
 * A staggered crossroads is two junctions maybe 20 m apart. Announced separately, the second
 * utterance cancels the first — `useAnnouncer` cancels rather than queues, on purpose — so the
 * rider hears half of "left" and then "right", which is worse than either alone.
 */
export const CHAIN_WITHIN_M = 120

/**
 * The turn to announce now, with whatever chains onto it, or null.
 *
 * Returns the *first* spoken turn inside the lead distance. Not the nearest: a rider standing
 * still at a junction has a turn at 0 m behind them and one at 40 m ahead, and the one to be
 * told about is the one they have not done.
 *
 * The turn that *chains* onto it only has to be actionable, not spoken. "Left, then bear
 * right" arrives in the same breath, so a slight turn costs nothing there — and a fork
 * immediately after a real turn is exactly the place a rider would otherwise go wrong.
 */
export function turnToAnnounce(
  turns: Turn[],
  alongM: number,
  speedMps: number | null,
): { turn: Turn; then: Turn | null } | null {
  const lead = leadDistanceM(speedMps)
  const turn = turns.find((t) => t.atM > alongM && t.atM - alongM <= lead && isSpoken(t))
  if (!turn) return null

  const then = turns.find(
    (t) => t.atM > turn.atM && t.atM - turn.atM <= CHAIN_WITHIN_M && isActionable(t),
  )
  return { turn, then: then ?? null }
}

/** `Left` / `Sharp right` / `3rd exit` — the words on the strip, where space is one line. */
export function turnLabel(turn: Turn): string {
  if (turn.kind === 'roundabout') return `${ordinal(turn.exit ?? 1)} exit`
  return SHORT[turn.kind]
}

const SHORT: Record<TurnKind, string> = {
  left: 'Left',
  'slight-left': 'Bear left',
  'sharp-left': 'Sharp left',
  'keep-left': 'Keep left',
  right: 'Right',
  'slight-right': 'Bear right',
  'sharp-right': 'Sharp right',
  'keep-right': 'Keep right',
  'u-turn': 'Turn around',
  roundabout: 'Roundabout',
  straight: 'Straight on',
  end: 'Finish',
  beeline: 'No road',
}

/**
 * What the synthesiser is given.
 *
 * Deliberately not `<desc>`, which BRouter already writes in English. Its wording is built for
 * a different set of clients, the app's distance vocabulary is its own (`spokenDistance`
 * exists because voices read "450 m" as "four hundred and fifty em"), and a cue list tested
 * against a fixture of somebody else's prose breaks when they reword it.
 */
export function spokenTurn(turn: Turn, then: Turn | null, away: string): string {
  const first =
    turn.kind === 'roundabout'
      ? `Roundabout in ${away}, ${ordinal(turn.exit ?? 1)} exit`
      : `${SPOKEN[turn.kind]} in ${away}`

  // "then right" and not "then turn right": by the second clause the rider is already being
  // told about turning, and the shorter phrase is the one that survives a passing lorry.
  return then ? `${first}, then ${THEN[then.kind]}.` : `${first}.`
}

const SPOKEN: Record<TurnKind, string> = {
  left: 'Left',
  'slight-left': 'Bear left',
  'sharp-left': 'Sharp left',
  'keep-left': 'Keep left',
  right: 'Right',
  'slight-right': 'Bear right',
  'sharp-right': 'Sharp right',
  'keep-right': 'Keep right',
  'u-turn': 'Turn around',
  roundabout: 'Roundabout',
  straight: 'Straight on',
  end: 'Finish',
  beeline: 'No road',
}

const THEN: Record<TurnKind, string> = {
  left: 'left',
  'slight-left': 'bear left',
  'sharp-left': 'sharp left',
  'keep-left': 'keep left',
  right: 'right',
  'slight-right': 'bear right',
  'sharp-right': 'sharp right',
  'keep-right': 'keep right',
  'u-turn': 'turn around',
  roundabout: 'the roundabout',
  straight: 'straight on',
  end: 'the finish',
  beeline: 'no road',
}

function ordinal(n: number): string {
  if (n === 1) return '1st'
  if (n === 2) return '2nd'
  if (n === 3) return '3rd'
  return `${n}th`
}
