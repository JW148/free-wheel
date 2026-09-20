import type { GradientAhead } from './climbs'

/**
 * What the riding HUD shows, and how much room it takes to show it.
 *
 * The panel has two sizes and they are not the same panel with the graph hidden. Collapsed, it
 * has to answer one question — *am I nearly there, and is anything about to hurt* — in a strip
 * a rider can ignore. So the rules for what survives the collapse live here, pure, because
 * they are the kind of thing that quietly rots into "show everything, smaller".
 *
 * ## Why the callout is conditional collapsed and unconditional expanded
 *
 * Expanded, "Nothing steep left on this route" is *useful*: the rider asked for the panel, and
 * a definite negative is information — it is why the panel can be put away. Collapsed, that
 * same line is a permanent sentence saying nothing, which is exactly the noise the collapse
 * was for. So collapsed, the line appears only when there is a hill to name, which makes its
 * appearance itself the signal: text on the strip means something is coming.
 */

/**
 * How far off a climb has to be before the collapsed strip bothers mentioning it.
 *
 * More generous than the 700 m the voice uses (`APPROACH_FROM_M` in `cues.ts`), and
 * deliberately: a glance is cheaper than an interruption, so the screen can afford to say it
 * earlier than the speaker can. 1.2 km is about three minutes — enough to finish thinking
 * about it before the road starts rising.
 */
export const CALLOUT_HORIZON_M = 1200

/**
 * Whether the collapsed strip should carry its one line of text.
 *
 * Climbs only. A descent ahead is worth a line on the expanded panel — "there is a break
 * coming" changes whether you push over the top — but it does not change what the legs do in
 * the next three minutes, and the collapsed strip's budget is one thing at a time.
 */
export function calloutMatters(ahead: GradientAhead | null, hasElevation: boolean): boolean {
  if (!hasElevation || ahead === null) return false
  return ahead.inIt || ahead.distanceToM <= CALLOUT_HORIZON_M
}

/**
 * How close a turn has to be before the collapsed strip gives it the line.
 *
 * Tighter than the climb's 1.2 km, and the other way round from how the speech horizons
 * compare. A climb is worth knowing about early because the decision it changes — gear,
 * effort, whether to eat something — is made minutes in advance. A turn is a thing you do at a
 * point, and 400 m of "left ahead" is a line that stops meaning anything before you reach it.
 */
export const TURN_HORIZON_M = 400

/**
 * Which of the two the collapsed strip's one line is about.
 *
 * The strip has room for exactly one, and that is the rule this file already holds: its budget
 * is one thing at a time, and text appearing on the strip is itself the signal. The expanded
 * panel has room for both and shows both, so this is only ever asked of the strip.
 *
 * A turn inside its horizon wins, because it is the one with a deadline. A climb announced
 * late is still a climb coming up; a turn announced late is a rider on the wrong road. Past
 * that horizon the climb keeps the line, which is where it spends most of a ride.
 */
export function calloutFor(
  turnAwayM: number | null,
  ahead: GradientAhead | null,
  hasElevation: boolean,
): 'turn' | 'climb' | null {
  if (turnAwayM !== null && turnAwayM <= TURN_HORIZON_M) return 'turn'
  return calloutMatters(ahead, hasElevation) ? 'climb' : null
}

/** What the opened panel can show. The rider swipes between whichever of these exist. */
export type HudPage = 'graph' | 'nav'

/**
 * The pages this ride has, in order.
 *
 * Only ever asked of the *opened* panel. The strip keeps its single auto-chosen line, because
 * one line has room for one thing and `calloutFor` already decides which — a rider folding the
 * panel away is asking for the map, not for a choice.
 *
 * Both pages are conditional on data the ride may not have, and the empty cases are real:
 * following a recorded track gives heights only where it was on a route, and a route saved
 * before the app asked BRouter for turn instructions has no junctions at all. A page drawn
 * from nothing is worse than a missing one — a flat graph is a claim that the road is level.
 *
 * Returning an array rather than two booleans is what keeps the swipe honest. With one page
 * there is nothing to swipe to, and the caller can see that without re-deriving it.
 */
export function hudPages(input: { hasElevation: boolean; hasTurns: boolean }): HudPage[] {
  const pages: HudPage[] = []
  // The graph first, because it is the one the panel has always opened onto and a rider who
  // never swipes should find what they had before.
  if (input.hasElevation) pages.push('graph')
  if (input.hasTurns) pages.push('nav')
  return pages
}

/** The page to draw, given what the rider last chose and what this ride actually has. */
export function hudPageAt(pages: HudPage[], index: number): HudPage | null {
  return pages[Math.min(Math.max(index, 0), pages.length - 1)] ?? null
}

/**
 * The four figures the expanded HUD carries.
 *
 * Every ride follows a line — a computed route, or a track someone rode and saved — so "to go"
 * and "arrive" always have an answer and the panel is always the same shape. It was not always
 * so: riding with nothing to follow used to be a mode, and it carried the pair a bike computer
 * shows instead. That mode is gone, and with it the branch.
 *
 * Returned as a list of keys rather than rendered here, so the HUD keeps its markup and this
 * keeps the decision.
 */
export type FigureKey = 'speed' | 'power' | 'togo' | 'arrive' | 'ridden'

export function figuresFor(input: { hasElevation: boolean }): FigureKey[] {
  // Power is derived from the route's gradient, so a route with no heights cannot produce one
  // — and a watts column that is always a dash is worse than a column that is not there.
  return input.hasElevation
    ? ['speed', 'power', 'togo', 'arrive']
    : ['speed', 'ridden', 'togo', 'arrive']
}

/** The three the collapsed strip keeps, from whichever set the expanded panel is showing. */
export function compactFigures(figures: FigureKey[]): FigureKey[] {
  // Speed always, then the two that answer "how much further" — dropping whichever of power or
  // distance-ridden is present, because neither changes a decision at a glance. Either set
  // leaves exactly three, which is what the strip has room for.
  return figures.filter((key) => key !== 'power' && key !== 'ridden')
}
