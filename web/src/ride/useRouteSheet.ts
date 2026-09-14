import { useState } from 'react'
import type { Plan } from './useRoute'

export type SheetView = 'compare' | 'detail'

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
     * Opens on whichever view is useful given what the rider has already decided.
     *
     * A chosen route means they want its detail; an open comparison means they still have a
     * choice to make. This is also what keeps the single-profile case unchanged — one route
     * is chosen automatically, so the drawer still opens straight onto its elevation profile.
     */
    openForPlan() {
      setView(plan.chosen && plan.routes[plan.chosen] ? 'detail' : 'compare')
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
