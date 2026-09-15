import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { sheetProgress, sheetRelease, wasTap, type SheetStop } from './sheetDrag'

/**
 * The plan sheet's finger, and the three numbers CSS needs to draw it.
 *
 * The sheet is one surface with two stops, and every difference between them — the side and
 * bottom insets, the corner radii, the height, the scrim, which of the two content layers is
 * legible — is written as a `calc()` over a single number, `--sheet-p`. This hook is what puts
 * a value in it: 0 at the card, 1 open, and whatever the finger says in between.
 *
 * Writing it straight to the element rather than through React state is deliberate. A drag
 * produces a value per frame, and a re-render per frame of a tree holding the route list, an
 * elevation chart and a climb list is a dropped frame per frame. React owns `open`; this owns
 * the number, and the two meet only at the ends of a gesture.
 *
 * ## Heights are measured, never assumed
 *
 * Neither stop has a constant height. The card is an invitation, a pair of coordinates or a
 * routed summary; the sheet is three route cards or a chart and a climb list. So both layers
 * are measured and published as `--sheet-card` and `--sheet-open`, and the sheet's own height
 * interpolates between them — the same arrangement the riding HUD uses, for the same reason.
 *
 * Both layers are laid out at a **constant width** (see `ride.css`), so measuring one while
 * the sheet is at the other's width still gives the right answer. Without that, opening would
 * re-wrap the text and retarget the animation it was halfway through.
 */
export function useSheetDrag({
  open,
  setOpen,
}: {
  open: boolean
  setOpen: (open: boolean) => void
}) {
  /** The element carrying the three custom properties. Everything else reads them by cascade. */
  const layer = useRef<HTMLDivElement | null>(null)
  const peek = useRef<HTMLDivElement | null>(null)
  const full = useRef<HTMLDivElement | null>(null)
  const range = useRef(0)
  const gesture = useRef<Gesture | null>(null)

  const setProgress = useCallback((p: number) => {
    layer.current?.style.setProperty('--sheet-p', String(p))
  }, [])

  useLayoutEffect(() => {
    const element = layer.current
    const card = peek.current
    const sheet = full.current
    if (!element || !card || !sheet) return

    const measure = () => {
      const cardH = card.getBoundingClientRect().height
      const openH = sheet.getBoundingClientRect().height
      range.current = openH - cardH
      element.style.setProperty('--sheet-card', `${cardH}px`)
      element.style.setProperty('--sheet-open', `${openH}px`)
    }

    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(card)
    observer.observe(sheet)
    return () => observer.disconnect()
  }, [])

  // React's state and the element's number, reconciled at the ends of a gesture and nowhere
  // else. Mid-drag this must not fire, or the sheet would snap back under the finger.
  useLayoutEffect(() => {
    if (gesture.current) return
    setProgress(open ? 1 : 0)
  }, [open, setProgress])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  const settle = useCallback(
    (stop: SheetStop) => {
      setProgress(stop === 'open' ? 1 : 0)
      setOpen(stop === 'open')
    },
    [setOpen, setProgress],
  )

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (gesture.current) return
      if (event.pointerType === 'mouse' && event.button !== 0) return

      // The handle always drags. The card behind it drags only where it is not a control —
      // Saved, Setup and Start ride have to stay taps, and a button that sometimes swallows
      // the press as a drag is a button a rider stops trusting.
      const fromHandle = event.currentTarget.hasAttribute('data-sheet-handle')
      if (!fromHandle && (event.target as Element).closest(CONTROLS)) return

      gesture.current = {
        id: event.pointerId,
        fromHandle,
        from: open ? 'open' : 'card',
        startY: event.clientY,
        travelled: 0,
        lastY: event.clientY,
        lastAt: event.timeStamp,
        velocity: 0,
        range: range.current,
      }
      layer.current?.setAttribute('data-dragging', 'yes')
      // Capture keeps the moves coming when the finger leaves the handle, which it does
      // immediately — the sheet is moving out from under it. It is allowed to fail (a pointer
      // already released, a synthetic event from a test harness) and the drag still works;
      // what must not happen is the attribute above going unset, leaving a transition fighting
      // the finger for every frame of the gesture.
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        /* not capturable — moves still arrive while the pointer is over the sheet */
      }
    },
    [open],
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const drag = gesture.current
      if (!drag || drag.id !== event.pointerId) return

      drag.travelled = drag.startY - event.clientY
      const elapsed = event.timeStamp - drag.lastAt
      // Two events in the same millisecond say nothing about speed, and dividing by their gap
      // says it very loudly.
      if (elapsed > 0) {
        drag.velocity = ((drag.lastY - event.clientY) / elapsed) * 1000
        drag.lastY = event.clientY
        drag.lastAt = event.timeStamp
      }
      setProgress(sheetProgress({ from: drag.from, travelledPx: drag.travelled, rangePx: drag.range }))
    },
    [setProgress],
  )

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const drag = gesture.current
      if (!drag || drag.id !== event.pointerId) return
      end(gesture, layer)

      // A press on the handle is left to the click it is about to produce — see `wasTap`.
      // Doing it here as well would toggle the sheet twice and land it back where it started.
      if (drag.fromHandle && wasTap(drag.travelled)) {
        setProgress(drag.from === 'open' ? 1 : 0)
        return
      }

      // A finger that came to rest before letting go was placing the sheet, not throwing it.
      const paused = event.timeStamp - drag.lastAt > STALE_MS
      settle(
        sheetRelease({
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
   * The gesture was taken away — a system edge swipe, a call arriving.
   *
   * It settles back where it started rather than committing. Same trap `HoldButton` has:
   * without this the sheet is left stranded at whatever fraction the finger reached, with
   * nothing pressing it and no event coming to finish the job.
   */
  const onPointerCancel = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const drag = gesture.current
      if (!drag || drag.id !== event.pointerId) return
      end(gesture, layer)
      settle(drag.from)
    },
    [settle],
  )

  /**
   * The handle's press, however it arrives.
   *
   * A keyboard, VoiceOver's activation and a plain finger all reach here as a click, which is
   * why the handle stayed a real button and why the pointer path stands aside for a press on
   * it rather than handling the tap itself.
   */
  const onClick = useCallback(() => setOpen(!open), [open, setOpen])

  return {
    layer,
    peek,
    full,
    /** Spread onto the handle and onto the card layer behind it. */
    drag: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
    onClick,
    collapse: useCallback(() => setOpen(false), [setOpen]),
  }
}

type Gesture = {
  id: number
  /** The handle produces a click of its own; the card behind it does not. */
  fromHandle: boolean
  from: SheetStop
  startY: number
  travelled: number
  lastY: number
  lastAt: number
  velocity: number
  range: number
}

/** Anything a press on the card means something else by. */
const CONTROLS = 'button, a, input, select, textarea, [role="button"]'

/** Longer than this since the last move and the finger had stopped, whatever it did before. */
const STALE_MS = 80

/* A second finger's release must not clear the first one's gesture, so every caller checks the
   pointer id before this is reached. */
function end(
  gesture: React.RefObject<Gesture | null>,
  layer: React.RefObject<HTMLDivElement | null>,
): void {
  gesture.current = null
  layer.current?.removeAttribute('data-dragging')
}
