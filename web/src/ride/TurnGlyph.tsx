import type { TurnKind } from './turns'

/**
 * The turn, as an arrow.
 *
 * ## Why a glyph and not just the words
 *
 * Everything else on the riding panel is read. This one is *recognised*, which is a different
 * and much cheaper act: a rider at 25 km/h glancing down has about a third of a second, and an
 * arrow bent to the left lands in that time where "Sharp left" has to be read. The words stay
 * next to it, because an arrow alone cannot say which exit.
 *
 * ## Why one construction rather than eleven drawings
 *
 * Every plain turn is the same figure at a different angle: a stem coming up from the bottom,
 * a corner, and a head. Drawing each one by hand means eleven chances for the arrowhead to sit
 * a pixel off or the stem to be a different length, and the set has to read as one family or
 * the angles stop being comparable. So the angle is the only input and the path is computed.
 *
 * The angles are BRouter's own distinctions: 35 degrees for a slight turn, 90 for a turn, 135
 * for a sharp one. They are not arbitrary and they are not evenly spread, because the thing
 * being drawn is what the road does.
 *
 * Three shapes are not that figure and are drawn on their own terms: the fork of a keep-left,
 * the loop of a U-turn, and the circle of a roundabout.
 */

const SIZE = 24
/** Where the stem stops and the manoeuvre starts. Centre, a little above it. */
const CORNER = { x: 12, y: 12 }
const ARM = 7
const HEAD = 3.6

/** Clockwise from straight ahead, in degrees, which is how a rider describes a turn. */
const ANGLES: Partial<Record<TurnKind, number>> = {
  straight: 0,
  'slight-left': -35,
  'slight-right': 35,
  left: -90,
  right: 90,
  'sharp-left': -135,
  'sharp-right': 135,
}

function arrow(degrees: number): string {
  const radians = (degrees * Math.PI) / 180
  const dx = Math.sin(radians)
  const dy = -Math.cos(radians)
  const tip = { x: CORNER.x + dx * ARM, y: CORNER.y + dy * ARM }

  // The two barbs, swept back 140 degrees either side of the direction of travel, so the head
  // stays the same shape whatever the angle underneath it.
  const barb = (sweep: number) => {
    const a = radians + (sweep * Math.PI) / 180
    return `${(tip.x - Math.sin(a) * HEAD).toFixed(2)} ${(tip.y + Math.cos(a) * HEAD).toFixed(2)}`
  }

  // A straight-on arrow has no corner to turn, so the stem simply runs into the head.
  const stem = degrees === 0 ? `M12 21 L${tip.x.toFixed(2)} ${tip.y.toFixed(2)}` : `M12 21 V12 L${tip.x.toFixed(2)} ${tip.y.toFixed(2)}`

  return `${stem} M${barb(-40)} L${tip.x.toFixed(2)} ${tip.y.toFixed(2)} L${barb(40)}`
}

export default function TurnGlyph({ kind }: { kind: TurnKind }) {
  return (
    <svg
      className="turn-glyph"
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      aria-hidden="true"
      focusable="false"
    >
      {shapeFor(kind)}
    </svg>
  )
}

function shapeFor(kind: TurnKind) {
  const angle = ANGLES[kind]
  if (angle !== undefined) return <path d={arrow(angle)} />

  if (kind === 'keep-left' || kind === 'keep-right') {
    const left = kind === 'keep-left'
    // A fork, with the road not taken drawn faint. Both branches have to be there: the whole
    // instruction is that there are two and one of them is wrong.
    return (
      <>
        <path className="turn-glyph-ghost" d={left ? 'M12 15 L17 9' : 'M12 15 L7 9'} />
        <path d={left ? 'M12 21 V15 L7 9 M7 13 V9 H11' : 'M12 21 V15 L17 9 M17 13 V9 H13'} />
      </>
    )
  }

  if (kind === 'u-turn') {
    // Up the right, round the top, back down the left, pointing where the rider came from.
    return <path d="M16 21 V13 A4 4 0 0 0 8 13 V18 M5 15 L8 18 L11 15" />
  }

  if (kind === 'roundabout') {
    // The island, the approach, and the way out. Which exit is in the words beside it — six
    // glyphs for six exit numbers would be six things to recognise instead of one.
    return (
      <>
        <circle cx="12" cy="10" r="4" />
        <path d="M12 21 V14 M16 10 H20 M17 7 L20 10 L17 13" />
      </>
    )
  }

  if (kind === 'end') {
    // A flag on a post. The finish, not a manoeuvre.
    return <path d="M8 21 V4 M8 5 H17 L14.5 8.5 L17 12 H8" />
  }

  // `beeline` and anything a future BRouter adds. A dash rather than an invented instruction.
  return <path d="M7 12 H17" />
}
