import { useCallback, useRef, useState } from 'react'
import { GLYPHS, type Glyph } from './glyphs'
import { BIKES, DEFAULT_BIKE, SLIDES, markOnboarded, type BikeChoice } from './slides'
import { swipeOffsetPx, swipeRelease, swipeVerdict } from './swipe'

/**
 * The first run: six cards, a pager, and one question that changes anything.
 *
 * ## Why it exists at all
 *
 * Every other screen in this app assumes you know what it is for. Nothing else explains that
 * the map has to be downloaded, that two taps produce three routes, or that location is used
 * and never sent anywhere — and all three are things a rider would otherwise discover by
 * being confused. Six cards is the smallest number that covers them and still ends on the
 * permission prompt, which has to be last because it is the only card that asks for
 * something.
 *
 * ## It is a carousel, so it swipes
 *
 * The pips under it say how many cards there are and which one you are on, which is a promise;
 * until now the only way to keep it was the Next button. Both work now, and the buttons are
 * still the path a keyboard and VoiceOver take. The gesture logic is in `swipe.ts`.
 *
 * ## It is shown once, and skipping counts
 *
 * Its own storage key rather than the maps gate's. See `hasOnboarded`.
 *
 * ## The location card is the reason the button label changes
 *
 * `getCurrentPosition` only prompts from a user gesture on iOS, and a prompt fired on mount
 * is a prompt the rider never connects to anything they did. So the last card's button asks
 * for it by name and the request happens inside that tap. A refusal is not an error here: the
 * app is perfectly usable planning routes by hand, and the ride screen already has a state
 * for "no location permission".
 */
export default function Onboarding({
  onDone,
}: {
  /** Called with the chosen bike once the walkthrough is finished or skipped. */
  onDone: (bike: BikeChoice) => void
}) {
  const [index, setIndex] = useState(0)
  const [bike, setBike] = useState(DEFAULT_BIKE.id)
  const last = SLIDES.length - 1
  const slide = SLIDES[index]
  const swipe = useSwipe({ index, last, onIndex: setIndex })

  const finish = useCallback(
    (askForLocation: boolean) => {
      markOnboarded()
      const chosen = BIKES.find((b) => b.id === bike) ?? DEFAULT_BIKE
      if (askForLocation && 'geolocation' in navigator) {
        // Inside the tap, and deliberately not awaited: the walkthrough closes either way, and
        // the permission sheet is the system's to manage from here. A denial lands in the ride
        // screen's `denied` state, which already says what to do about it.
        navigator.geolocation.getCurrentPosition(
          () => {},
          () => {},
          { enableHighAccuracy: false, timeout: 10_000 },
        )
      }
      onDone(chosen)
    },
    [bike, onDone],
  )

  const next = () => (index === last ? finish(true) : setIndex(index + 1))

  return (
    <div className="onboarding">
      <header className="onboarding-head">
        <span className="onboarding-brand">
          <img src="/icons/icon-192.png" alt="" width={26} height={26} />
          Free Wheel
        </span>
        {/* Skips to the end rather than closing: the last card is the permission ask, and a
            rider who skips the explanation still needs to be offered location once. */}
        <button type="button" className="onboarding-skip" onClick={() => setIndex(last)}>
          Skip
        </button>
      </header>

      {/*
        One track translated by index, rather than one card swapped in and out. The cards either
        side stay mounted, so the movement is a real slide and the glyphs do not re-render
        mid-transition — and so a swipe reveals the next card rather than a gap.

        `--slide-dx` is the finger, added to the index's own translation. It is written straight
        to the element rather than through state, like the plan sheet's `--sheet-p` and for the
        same reason: a re-render per frame of six mounted cards is a dropped frame per frame.
      */}
      <div className="onboarding-viewport" ref={swipe.viewport}>
        <div
          className="onboarding-track"
          ref={swipe.track}
          {...swipe.handlers}
          style={{
            width: `${SLIDES.length * 100}%`,
            transform: `translateX(calc(${-index * (100 / SLIDES.length)}% + var(--slide-dx, 0px)))`,
          }}
        >
          {SLIDES.map((card, i) => (
            <section
              key={card.glyph}
              className="onboarding-card"
              style={{ width: `${100 / SLIDES.length}%` }}
              // `inert` rather than `aria-hidden` alone: every card stays mounted so the
              // movement is a real slide, and a hidden card whose bike chips are still
              // focusable is a tab order that walks off the side of the screen.
              inert={i === index ? undefined : true}
            >
              <div className="onboarding-tile">
                <PixelGlyph glyph={GLYPHS[card.glyph]} />
              </div>
              <h1>{card.title}</h1>
              <p>{card.body}</p>

              {card.bikes && (
                <div className="onboarding-chips" role="radiogroup" aria-label="What are you riding?">
                  {BIKES.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      role="radio"
                      aria-checked={bike === option.id}
                      className="chip"
                      data-selected={bike === option.id ? 'yes' : 'no'}
                      onClick={() => setBike(option.id)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              )}

              {card.location && (
                <p className="onboarding-reassure">
                  <span className="onboarding-dot" aria-hidden="true" />
                  Only used while the app is open. Nothing is uploaded.
                </p>
              )}
            </section>
          ))}
        </div>
      </div>

      <footer className="onboarding-foot">
        <div className="onboarding-dots">
          {SLIDES.map((card, i) => (
            <button
              key={card.glyph}
              type="button"
              className="onboarding-dot-button"
              data-current={i === index ? 'yes' : 'no'}
              aria-label={`Card ${i + 1} of ${SLIDES.length}`}
              aria-current={i === index ? 'step' : undefined}
              onClick={() => setIndex(i)}
            />
          ))}
        </div>
        <div className="action-row">
          {index > 0 && (
            <button
              type="button"
              className="secondary onboarding-back"
              aria-label="Previous card"
              onClick={() => setIndex(index - 1)}
            >
              <ChevronLeft />
            </button>
          )}
          <button type="button" className="primary" onClick={next}>
            {slide.location ? 'Allow location & start' : 'Next'}
          </button>
        </div>
      </footer>
    </div>
  )
}

/**
 * A glyph as a CSS grid of spans.
 *
 * `aria-hidden` because it is decoration: the title beside it says what the card is about, and
 * a screen reader announcing 280 empty cells would be worse than useless. The cell size is a
 * custom property so the same component serves the 12px tile here and anything smaller later.
 */
function PixelGlyph({ glyph }: { glyph: Glyph }) {
  return (
    <div className="pixel-glyph" aria-hidden="true">
      {glyph.map((row, y) => (
        <div key={y} className="pixel-row">
          {row.map((colour, x) => (
            <span key={x} style={colour ? { background: colour } : undefined} />
          ))}
        </div>
      ))}
    </div>
  )
}

function ChevronLeft() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" width={20} height={20} fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 5l-7 7 7 7" />
    </svg>
  )
}

/**
 * The finger on the deck.
 *
 * Bookkeeping only: subtract two clientXs, ask `swipe.ts` what that means, and either write the
 * offset to the track or stand aside. `data-dragging` turns the track's transition off for the
 * length of the gesture — under a finger there is nothing to interpolate towards.
 *
 * A press starts *pending*, exactly as the plan sheet's body drag does, so a tap on a bike chip
 * is still that tap and a scroll down a long card is still that scroll.
 */
function useSwipe({
  index,
  last,
  onIndex,
}: {
  index: number
  last: number
  onIndex: (index: number) => void
}) {
  const viewport = useRef<HTMLDivElement | null>(null)
  const track = useRef<HTMLDivElement | null>(null)
  const gesture = useRef<{
    id: number
    pending: boolean
    startX: number
    startY: number
    dx: number
    lastX: number
    lastAt: number
    velocity: number
  } | null>(null)

  const offset = (px: number) => track.current?.style.setProperty('--slide-dx', `${px}px`)

  const end = () => {
    gesture.current = null
    track.current?.removeAttribute('data-dragging')
    offset(0)
  }

  const onPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (gesture.current) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    gesture.current = {
      id: event.pointerId,
      pending: true,
      startX: event.clientX,
      startY: event.clientY,
      dx: 0,
      lastX: event.clientX,
      lastAt: event.timeStamp,
      velocity: 0,
    }
  }

  const onPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const drag = gesture.current
    if (!drag || drag.id !== event.pointerId) return

    if (drag.pending) {
      const verdict = swipeVerdict(event.clientX - drag.startX, event.clientY - drag.startY)
      if (verdict === 'abandon') {
        gesture.current = null
        return
      }
      if (verdict === 'wait') return
      drag.pending = false
      drag.startX = event.clientX
      track.current?.setAttribute('data-dragging', 'yes')
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        /* not capturable — moves still arrive while the pointer is over the track */
      }
    }

    drag.dx = event.clientX - drag.startX
    const elapsed = event.timeStamp - drag.lastAt
    if (elapsed > 0) {
      drag.velocity = ((event.clientX - drag.lastX) / elapsed) * 1000
      drag.lastX = event.clientX
      drag.lastAt = event.timeStamp
    }
    offset(swipeOffsetPx(drag.dx, index, last))
  }

  const onPointerUp = (event: React.PointerEvent<HTMLElement>) => {
    const drag = gesture.current
    if (!drag || drag.id !== event.pointerId) return
    const settled = drag.pending
      ? index
      : swipeRelease({
          index,
          last,
          dxPx: drag.dx,
          // A finger that came to rest before letting go was placing the deck, not throwing it.
          velocityPxPerS: event.timeStamp - drag.lastAt > 80 ? 0 : drag.velocity,
          widthPx: viewport.current?.getBoundingClientRect().width ?? 0,
        })
    end()
    if (settled !== index) onIndex(settled)
  }

  /* Taken away — a system edge swipe, a call arriving. Same trap `HoldButton` has: without
     this the track is left stranded at whatever offset the finger reached. */
  const onPointerCancel = (event: React.PointerEvent<HTMLElement>) => {
    if (gesture.current?.id !== event.pointerId) return
    end()
  }

  return {
    viewport,
    track,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
  }
}
