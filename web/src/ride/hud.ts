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
