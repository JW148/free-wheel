import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * A button that has to be held, for the one destructive thing on the riding screen.
 *
 * ## Why ending a ride is not a tap
 *
 * The riding screen is used on rough ground by someone wearing gloves, with one hand, while
 * moving. A tap is a gesture a pothole can make on the rider's behalf, and the cost of getting
 * it wrong is asymmetric: a ride ended by accident is a ride whose recording has stopped and
 * whose map has zoomed out, discovered some minutes later. A hold cannot be made by a bump.
 *
 * This is the same argument the app already makes about the text field — iOS shake-to-undo
 * cannot be refused, so the riding screen carries no input at all. Same environment, same
 * conclusion, different mechanism.
 *
 * ## The fill is the instruction
 *
 * There is no "hold to end" tooltip and no first-use hint, because the fill sweeping across the
 * button says it in the only language available at 25 km/h. Letting go early visibly undoes it,
 * which is what teaches the gesture on the first attempt rather than the second.
 *
 * The fill is a CSS transition on `width` rather than an animation frame loop: a rider's
 * finger is on the screen for 700 ms and the panel behind this is backdrop-filtered, so the
 * fewer things asking for a frame, the better. `pointercancel` matters as much as `pointerup` —
 * a scroll or a system gesture taking over the pointer has to abandon the hold, or the ride
 * ends because the rider swiped.
 */
export default function HoldButton({
  children,
  onHold,
  holdMs = 700,
  className,
  ...rest
}: {
  children: React.ReactNode
  onHold: () => void
  /** How long the press has to last. 700 ms is long enough to be deliberate, short enough not
      to feel broken. */
  holdMs?: number
  className?: string
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'>) {
  const [holding, setHolding] = useState(false)
  const timer = useRef<number | null>(null)

  const stop = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
    setHolding(false)
  }, [])

  // A component unmounted mid-hold — which is exactly what happens when the hold *succeeds* —
  // must not leave a timer that fires into nothing.
  useEffect(() => stop, [stop])

  const start = () => {
    if (timer.current !== null) return
    setHolding(true)
    timer.current = window.setTimeout(() => {
      timer.current = null
      setHolding(false)
      onHold()
    }, holdMs)
  }

  return (
    <button
      type="button"
      className={['hold-button', className].filter(Boolean).join(' ')}
      data-holding={holding ? 'yes' : 'no'}
      style={{ '--hold-ms': `${holdMs}ms` } as React.CSSProperties}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      // A scroll, a system edge gesture, or a second finger takes the pointer away. Without
      // this the hold keeps running with nothing pressing it.
      onPointerCancel={stop}
      {...rest}
    >
      <span className="hold-fill" aria-hidden="true" />
      <span className="hold-label">{children}</span>
    </button>
  )
}
