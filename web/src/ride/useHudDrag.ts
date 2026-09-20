import { useCallback, useLayoutEffect, useRef } from 'react'
import {
  hudAxis,
  hudPageRelease,
  hudProgress,
  hudRelease,
  type HudAxis,
  type HudStop,
} from './hudDrag'
import { wasTap } from './sheetDrag'

/**
 * The riding panel's finger, and the three numbers CSS needs to draw it.
 *
 * The panel has two sizes and used to swap between them on a chevron: one tap, a `height`
 * transition, and a cross-fade that ran to completion whatever the hand that started it did
 * next. It is now the plan sheet's arrangement at the other end of the screen — one surface,
 * one number, and every difference between the two sizes a `calc()` over it. `--hud-p` is 0
 * on the strip and 1 on the graph; pull down to grow it, push up to fold it away.
 *
 * Written straight to the element rather than through React state, for the sheet's reason: a
 * drag produces a value per frame, and the riding screen is re-rendering a map, a chart and a
 * clock already. React owns `expanded` — it is persisted across launches — and this owns the
 * number between the ends of a gesture.
 *
 * ## Both sizes are measured, and neither is a constant
 *
 * The strip grows a climb line when there is a climb to name and loses it afterwards; the
 * graph's callout wraps to two lines on a narrow phone. So both layers are measured by a
 * `ResizeObserver` and published as `--hud-mini` and `--hud-full`, and the panel's height
 * interpolates between them. This is what the panel already did — the measurement is not new,
 * only what reads it.
 *
 * ## And now a second axis, which the first dozen pixels arbitrate
 *
 * The opened panel holds pages — the elevation graph, and the next turn drawn big enough to
 * read at speed. Sideways changes the page, `--hud-x` carries it, and it is the same mechanism
 * as `--hud-p` rather than a new one.
 *
 * A finger does not say which axis it meant, so `hudAxis` waits until one is clearly ahead and
 * **nothing is written until it decides**. Guessing on the first move would resize the panel a
 * few pixels at the start of every page swipe, which is exactly the "figures changing size
 * while you read them" this panel already refuses to do on a tap.
 */
export function useHudDrag({
  expanded,
  onExpandedChange,
  page = 0,
  pages = 1,
  onPageChange,
}: {
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  /** Which page the opened panel is on, clamped by the caller to the pages that exist. */
  page?: number
  pages?: number
  onPageChange?: (page: number) => void
}) {
  /** The panel. It carries the custom properties; everything inside reads them by cascade. */
  const panel = useRef<HTMLDivElement | null>(null)
  const mini = useRef<HTMLDivElement | null>(null)
  const full = useRef<HTMLDivElement | null>(null)
  const range = useRef(0)
  const gesture = useRef<Gesture | null>(null)
  /** Set when a gesture that started on the chevron turned out to be a drag. See `onPointerUp`. */
  const suppressClick = useRef(false)

  const setProgress = useCallback((p: number) => {
    panel.current?.style.setProperty('--hud-p', String(p))
  }, [])

  /** Which page the track is showing, as a fraction, so a drag can sit between two. */
  const setPage = useCallback((x: number) => {
    panel.current?.style.setProperty('--hud-x', String(x))
  }, [])

  useLayoutEffect(() => {
    const element = panel.current
    const strip = mini.current
    const graph = full.current
    if (!element || !strip || !graph) return

    let armed = false
    let frame = 0

    const measure = () => {
      const miniH = strip.getBoundingClientRect().height
      const fullH = graph.getBoundingClientRect().height
      range.current = fullH - miniH
      element.style.setProperty('--hud-mini', `${miniH}px`)
      element.style.setProperty('--hud-full', `${fullH}px`)
      /*
       * Transitions stay off until a frame after the first measurement.
       *
       * The stylesheet's fallback heights are a guess, and a transition's properties are taken
       * from the *after*-change style — so setting the real pair and `data-measured` in the
       * same recalculation would animate the panel from the guess to the truth, on arrival, in
       * front of a rider who has just pressed Start. A frame later there is nothing left to
       * animate from, and every change after that one is honest.
       */
      if (armed || miniH === 0 || fullH === 0) return
      armed = true
      frame = requestAnimationFrame(() => element.setAttribute('data-measured', 'yes'))
    }

    measure()
    if (typeof ResizeObserver === 'undefined') return () => cancelAnimationFrame(frame)
    const observer = new ResizeObserver(measure)
    observer.observe(strip)
    observer.observe(graph)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [])

  // React's state and the element's numbers, reconciled at the ends of a gesture and nowhere
  // else. Mid-drag these must not fire, or the panel would snap back under the finger.
  useLayoutEffect(() => {
    if (gesture.current) return
    setProgress(expanded ? 1 : 0)
  }, [expanded, setProgress])

  useLayoutEffect(() => {
    if (gesture.current) return
    setPage(page)
  }, [page, setPage])

  const settle = useCallback(
    (stop: HudStop) => {
      setProgress(stop === 'full' ? 1 : 0)
      onExpandedChange(stop === 'full')
    },
    [onExpandedChange, setProgress],
  )

  const settlePage = useCallback(
    (next: number) => {
      setPage(next)
      if (next !== page) onPageChange?.(next)
    },
    [onPageChange, page, setPage],
  )

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (gesture.current) return
      if (event.pointerType === 'mouse' && event.button !== 0) return
      // The chevron is a button and produces its own click. Dragging *from* it is still allowed
      // — it is the one part of the panel that looks like a grab handle — but a press that
      // turns out to be a tap is left to that click, exactly as the sheet's handle is.
      const chevron = (event.target as Element).closest('.hud-collapse')
      const fromChevron = chevron !== null

      gesture.current = {
        id: event.pointerId,
        fromChevron,
        from: expanded ? 'full' : 'mini',
        startY: event.clientY,
        travelled: 0,
        lastY: event.clientY,
        lastAt: event.timeStamp,
        velocity: 0,
        range: range.current,
        /*
         * Sideways is only offered on the opened panel, and only when there is more than one
         * page. Folded, the strip is a single line whose one callout `calloutFor` already
         * chooses — a swipe there would be a gesture with nowhere to go, and a gesture that
         * sometimes does nothing is worse than one that never existed.
         */
        axis: expanded && pages > 1 ? 'wait' : 'resize',
        startX: event.clientX,
        across: 0,
        lastX: event.clientX,
        velocityX: 0,
        fromPage: page,
        /*
         * The *window's* width, not the panel's.
         *
         * A page is the layer's content box: the panel's border box less its border and less
         * 0.7rem of layer padding either side. At 390 px that is 341.6 against the panel's
         * 366, so measuring the panel makes the track lag the finger by up to 24 px and moves
         * the half-page release threshold 12 px out. The CSS was careful that the translation
         * is exactly one page; this is the other half of that.
         */
        width:
          panel.current?.querySelector('.hud-pages')?.getBoundingClientRect().width ??
          panel.current?.getBoundingClientRect().width ??
          0,
      }
      panel.current?.setAttribute('data-dragging', 'yes')
      /*
       * Capture keeps the moves coming when the finger leaves the panel, which on a fold it
       * does immediately — the bottom edge is travelling out from under it.
       *
       * On the **chevron itself**, though. A pointer capture retargets the compatibility mouse
       * events with it, `click` included: capturing to the panel would swallow the chevron's
       * own click and leave a button that does nothing when pressed. Captured to the chevron,
       * the click still fires there and the moves still reach the panel's handler by bubbling.
       *
       * Allowed to fail; what must not happen is `data-dragging` going unset, which would
       * leave a transition fighting the finger for every frame of the gesture.
       */
      try {
        ;(chevron ?? event.currentTarget).setPointerCapture(event.pointerId)
      } catch {
        /* not capturable — moves still arrive while the pointer is over the panel */
      }
    },
    [expanded, page, pages],
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const drag = gesture.current
      if (!drag || drag.id !== event.pointerId) return

      drag.travelled = event.clientY - drag.startY
      drag.across = event.clientX - drag.startX
      const elapsed = event.timeStamp - drag.lastAt
      // Two events in the same millisecond say nothing about speed, and dividing by their gap
      // says it very loudly.
      if (elapsed > 0) {
        drag.velocity = ((event.clientY - drag.lastY) / elapsed) * 1000
        drag.velocityX = ((event.clientX - drag.lastX) / elapsed) * 1000
        drag.lastY = event.clientY
        drag.lastX = event.clientX
        drag.lastAt = event.timeStamp
      }

      if (drag.axis === 'wait') drag.axis = hudAxis(drag.across, drag.travelled)
      // Still undecided: write nothing. Half a gesture applied to both axes is how a page
      // swipe ends up nudging the panel's height on its way past.
      if (drag.axis === 'wait') return

      if (drag.axis === 'page') {
        const offset = drag.width > 0 ? drag.across / drag.width : 0
        // Clamped to the pages that exist, so a swipe past the end resists rather than
        // dragging the track into the margin and springing back from nowhere.
        const wanted = drag.fromPage - offset
        setPage(Math.min(pages - 1, Math.max(0, wanted)))
        return
      }

      setProgress(hudProgress({ from: drag.from, travelledPx: drag.travelled, rangePx: drag.range }))
    },
    [pages, setPage, setProgress],
  )

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const drag = gesture.current
      if (!drag || drag.id !== event.pointerId) return
      end(gesture, panel)

      /*
       * Was this a press, or a gesture that happened to start on the chevron?
       *
       * Measured over **both** axes, which it was not: `wasTap(drag.travelled)` looks only at
       * the vertical, so a clean sideways swipe reads as a tap because it barely moved down.
       * That matters more than it sounds, because the page dots are painted inside the
       * chevron's hit strip — they span the full width of the bottom edge — so the one thing
       * on screen saying "there is another page" is the worst place to start a swipe from.
       */
      const moved = !wasTap(Math.hypot(drag.across, drag.travelled))

      // A real press on the chevron is left to the click it is about to produce. Doing it here
      // as well would toggle twice and land the panel back where it started.
      if (drag.fromChevron && !moved) {
        setProgress(drag.from === 'full' ? 1 : 0)
        setPage(drag.fromPage)
        return
      }

      /*
       * It moved, so the click that is about to arrive is not a press and must not toggle.
       *
       * The capture is deliberately on the chevron so its click survives a drag *from* it —
       * see `onPointerDown`. That is right for a tap and wrong for everything else: without
       * this, a swipe to the next page also folds the panel, and a vertical drag that settles
       * back where it started folds it too. The second of those predates the pages.
       */
      if (drag.fromChevron) suppressClick.current = true

      // A finger that came to rest before letting go was placing the panel, not throwing it.
      const paused = event.timeStamp - drag.lastAt > STALE_MS

      if (drag.axis === 'page') {
        settlePage(
          hudPageRelease({
            from: drag.fromPage,
            travelledPx: drag.across,
            velocityPxPerS: paused ? 0 : drag.velocityX,
            widthPx: drag.width,
            pages,
          }),
        )
        return
      }

      // Undecided at release is a press that travelled less than the axis threshold, which is
      // a tap — and a tap anywhere but the chevron deliberately does nothing. Both axes are
      // written home rather than only the one that happens to be in play: a gesture can travel
      // far enough to write `--hud-x` and still not reach the threshold that commits it.
      if (drag.axis === 'wait') {
        setProgress(drag.from === 'full' ? 1 : 0)
        setPage(drag.fromPage)
        return
      }

      settle(
        hudRelease({
          from: drag.from,
          travelledPx: drag.travelled,
          velocityPxPerS: paused ? 0 : drag.velocity,
          rangePx: drag.range,
        }),
      )
    },
    [pages, settle, settlePage, setProgress],
  )

  /**
   * The gesture was taken away — a system edge swipe, a call arriving, a hand knocked off.
   *
   * It settles back where it started rather than committing. Same trap `HoldButton` has:
   * without this the panel is left stranded at whatever fraction the finger reached, with
   * nothing pressing it and no event coming to finish the job.
   */
  const onPointerCancel = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const drag = gesture.current
      if (!drag || drag.id !== event.pointerId) return
      end(gesture, panel)
      // Both axes go home, because either may have been written to before the gesture was
      // taken away and only one of them knows which.
      setPage(drag.fromPage)
      settle(drag.from)
    },
    [settle, setPage],
  )

  /**
   * The chevron's press, however it arrives.
   *
   * A keyboard, VoiceOver's activation and a plain finger all reach here as a click, which is
   * why the chevron stayed a real button and why the pointer path stands aside for a press on
   * it rather than handling the tap itself.
   */
  const onToggle = useCallback(() => {
    // The click a drag from the chevron leaves behind. Swallowed once, because the gesture has
    // already been dealt with — otherwise a swipe to the next page folds the panel on its way.
    if (suppressClick.current) {
      suppressClick.current = false
      return
    }
    onExpandedChange(!expanded)
  }, [expanded, onExpandedChange])

  return {
    panel,
    mini,
    full,
    /** Spread onto the panel. The whole surface is the target. */
    drag: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
    onToggle,
  }
}

type Gesture = {
  id: number
  /** The chevron produces a click of its own; the rest of the panel does not. */
  fromChevron: boolean
  from: HudStop
  startY: number
  /** Positive towards the graph, which is downwards on the glass. */
  travelled: number
  lastY: number
  lastAt: number
  velocity: number
  range: number
  /** `wait` until the first dozen pixels say which way this is going. See `hudAxis`. */
  axis: HudAxis
  startX: number
  /** Positive when the finger moved right, which reveals the page before this one. */
  across: number
  lastX: number
  velocityX: number
  fromPage: number
  /** The panel's width, read once at the start rather than per move. */
  width: number
}

/** Longer than this since the last move and the finger had stopped, whatever it did before. */
const STALE_MS = 80

/* A second finger's release must not clear the first one's gesture, so every caller checks the
   pointer id before this is reached. */
function end(
  gesture: React.RefObject<Gesture | null>,
  panel: React.RefObject<HTMLDivElement | null>,
): void {
  gesture.current = null
  panel.current?.removeAttribute('data-dragging')
}
