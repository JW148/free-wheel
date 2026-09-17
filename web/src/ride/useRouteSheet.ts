import { useState } from 'react'
import type { Plan } from './useRoute'

export type SheetView = 'compare' | 'detail'

/**
 * Which view a reopening sheet lands on: the one it left, unless that view has nothing to say.
 *
 * The detail view describes the chosen route, and `plan.chosen` is nullable on purpose — it is
 * `null` until a card is tapped, and clearing a choice does not close the sheet. So "the view
 * you were last on" has one exception, and it is the same `null` check every reader of "the
 * route" has to make.
 */
export function viewOnOpen(
  view: SheetView,
  plan: { chosen: string | null; routes: Record<string, unknown> },
): SheetView {
  if (view !== 'detail') return view
  return plan.chosen !== null && plan.routes[plan.chosen] ? 'detail' : 'compare'
}

/**
 * The drawer's open state and which view it is showing.
 *
 * Owned by `RideView` rather than by the sheet, because a tap on a route line on the map has
 * to be able to open the detail view — the map and the sheet are two ways into the same
 * decision, and only their common parent can see both.
 */
export function useRouteSheet(plan: Plan) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<SheetView>('compare')

  return {
    open,
    view,
    setOpen,
    setView,
    /**
     * Opens on the view it was last put away on.
     *
     * It used to re-derive the view from the plan every time — a chosen route meant the
     * detail, anything else meant the comparison — which sounds right and is wrong the moment
     * the rider has already said otherwise. Choosing a route does not leave the comparison, so
     * a rider weighing three cards with one ticked would minimise the sheet, pull it back up
     * and land on that route's climbs instead of the list they were reading. The sheet is one
     * surface with two stops; the view is what is *on* it, and putting it down is not a change
     * of mind.
     *
     * The only thing that overrules it is a view that can no longer be drawn — see
     * {@link viewOnOpen}.
     */
    openForPlan() {
      setView(viewOnOpen(view, plan))
      setOpen(true)
    },
    showCompare() {
      setView('compare')
      setOpen(true)
    },
    /**
     * Commits to a route.
     *
     * It does **not** open the detail view any more, and that is the redesign's point: a tap on
     * a card — or on a line on the map — is the rider saying "this one", and the useful next
     * thing is Start, which appears on the card itself. Throwing a full sheet of climbs over
     * the map at the moment they picked a route made choosing feel like a commitment to
     * reading. Details is now a row on the chosen card, for the riders who want it.
     */
    choose(id: string) {
      plan.chooseProfile(id)
      setOpen(true)
    },
    /**
     * Drops the choice and shows the comparison again.
     *
     * Always lands on the compare view: the detail view has nothing to describe once there is
     * no chosen route, and leaving it on screen would show the previous choice's figures for
     * a frame before collapsing.
     */
    clearChoice() {
      plan.clearChoice()
      setView('compare')
    },
  }
}

export type RouteSheetState = ReturnType<typeof useRouteSheet>
