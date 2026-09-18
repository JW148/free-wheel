import { useCallback, useLayoutEffect, useRef } from 'react'
import { hudProgress, hudRelease, type HudStop } from './hudDrag'
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
 */
export function useHudDrag({
  expanded,
  onExpandedChange,
}: {
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
}) {
  /** The panel. It carries the custom properties; everything inside reads them by cascade. */
  const panel = useRef<HTMLDivElement | null>(null)
  const mini = useRef<HTMLDivElement | null>(null)
  const full = useRef<HTMLDivElement | null>(null)
  const range = useRef(0)
  const gesture = useRef<Gesture | null>(null)

  const setProgress = useCallback((p: number) => {
    panel.current?.style.setProperty('--hud-p', String(p))
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

  // React's state and the element's number, reconciled at the ends of a gesture and nowhere
  // else. Mid-drag this must not fire, or the panel would snap back under the finger.
  useLayoutEffect(() => {
    if (gesture.current) return
    setProgress(expanded ? 1 : 0)
  }, [expanded, setProgress])

  const settle = useCallback(
    (stop: HudStop) => {
      setProgress(stop === 'full' ? 1 : 0)
      onExpandedChange(stop === 'full')
    },
    [onExpandedChange, setProgress],
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
    [expanded],
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const drag = gesture.current
      if (!drag || drag.id !== event.pointerId) return

      drag.travelled = event.clientY - drag.startY
      const elapsed = event.timeStamp - drag.lastAt
      // Two events in the same millisecond say nothing about speed, and dividing by their gap
      // says it very loudly.
      if (elapsed > 0) {
        drag.velocity = ((event.clientY - drag.lastY) / elapsed) * 1000
        drag.lastY = event.clientY
        drag.lastAt = event.timeStamp
      }
      setProgress(hudProgress({ from: drag.from, travelledPx: drag.travelled, rangePx: drag.range }))
    },
    [setProgress],
  )

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const drag = gesture.current
      if (!drag || drag.id !== event.pointerId) return
      end(gesture, panel)

      // A press on the chevron is left to the click it is about to produce. Doing it here as
      // well would toggle twice and land the panel back where it started.
      if (drag.fromChevron && wasTap(drag.travelled)) {
        setProgress(drag.from === 'full' ? 1 : 0)
        return
      }

      // A finger that came to rest before letting go was placing the panel, not throwing it.
      const paused = event.timeStamp - drag.lastAt > STALE_MS
      settle(
        hudRelease({
          from: drag.from,
          travelledPx: drag.travelled,
          velocityPxPerS: paused ? 0 : drag.velocity,
          rangePx: drag.range,
        }),
      )
    },
    [settle, setProgress],
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
      settle(drag.from)
    },
    [settle],
  )

  /**
   * The chevron's press, however it arrives.
   *
   * A keyboard, VoiceOver's activation and a plain finger all reach here as a click, which is
   * why the chevron stayed a real button and why the pointer path stands aside for a press on
   * it rather than handling the tap itself.
   */
  const onToggle = useCallback(() => onExpandedChange(!expanded), [expanded, onExpandedChange])

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
