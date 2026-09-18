# Phase 13 — three quirks off the ride screen

Implemented 2026-09-17, from four screenshots and a short list: the riding panel should be
*dragged* between its two sizes rather than tapped, the plan sheet should reopen on the view it
was put away on, and Saved's detail should not carry a second way back.

Three changes. Only the first is new machinery, and it is machinery the app already had — the
plan sheet's, turned upside down.

---

## 1 · The riding panel folded on a chevron, and the chevron was the only way

The HUD has two sizes: the strip (three figures and the whole-route bar) and the panel (four
figures, the lookahead graph, the bar and a line about the next hill). Moving between them was a
2.4 rem chevron in the bottom-right corner, and everything about that was a control: a tap
target you have to find, a `height` transition that ran to completion whatever the hand that
started it did next, and a cross-fade underneath it that knew only its two ends.

Nothing inside the panel is interactive, which is the fact the fix turns on: **the whole surface
can be the target**. So it is now the plan sheet's mechanism at the other end of the screen —
one surface, one number, and every difference between the two sizes a `calc()` over it.

- `--hud-p` runs 0 on the strip to 1 on the graph. The panel's height interpolates between
  `--hud-mini` and `--hud-full`, both measured; each layer's opacity is a `calc()` over it; and
  the chevron's rotation is `rotate(calc(180deg * (1 - var(--hud-p))))`, so the glyph turns with
  the finger rather than after it.
- `useHudDrag` writes the number straight to the element, as `useSheetDrag` does and for the
  same reason: a drag produces a value per frame, and the riding screen is already re-rendering
  a map, a chart and a clock. React owns `expanded` — it is persisted across launches — and the
  hook owns the number between the ends of a gesture.
- `hudDrag.ts` is the pure part. `hudProgress` is `sheetProgress` with the stops renamed, since
  the arithmetic is identical once the sign is fixed: the sheet grows upwards from the bottom of
  the screen and the panel grows downwards from the top, so `travelledPx` is positive
  **downwards** here.

### The one place it parts company with the sheet: a tap does not toggle

`sheetRelease` treats a still release as a tap and toggles, because the sheet's gesture starts on
a handle and a control that does nothing when pressed is a control a rider stops believing in.
`hudRelease` returns `from` instead. The HUD's gesture starts anywhere on a panel occupying the
top quarter of the riding screen — which is also where a hand lands coming back to the bars — and
a toggle on contact would resize the figures being read. Dragging changes the size; the chevron
changes the size; brushing it does not.

### The chevron moved to the bottom edge, centred

It used to sit bottom-right expanded and top-right collapsed, in the gutter the compact figure
row reserved for it. That is where a *control* goes. Now that the surface drags, the chevron's
job is to **say so**, which makes it a handle: centred, spanning the width, in a 1.2 rem strip
both layers leave clear along the bottom. It is still a real button with a real `onClick`, so a
keyboard and VoiceOver have a way in, and the pointer path stands aside for the click it
produces — the same `wasTap` arrangement the sheet's handle has.

Two gutters went with it: `padding-right: 2.4rem` on the compact figure row and
`margin-right: 2.3rem` on the callout. The callout line now has the panel's full width, which is
what "Climbing 0 m left · 0 m up · 4% now" wanted in the first place.

### The cross-fade hands over; it does not blend

The first attempt conserved ink — `1 - p` and `p` — on the theory that the two layers carry the
same figures, so the panel should never go dim. They do not sit in the same places: the strip is
three columns and the graph is four, so "93 km" is the third of three *and* the third of four,
and half of each at once is that number printed twice an inch apart with "23:38" doubled beside
it. Unreadable exactly while it is being read; visible in `19b-hud-half-dragged.png` from the
first driven pass.

So each layer is scaled and offset to be gone by the half-way point and to start from it —
`calc(1.05 - p * 2.1)` and `calc(p * 2.1 - 1.05)`. One is legible or the other is.

### `data-measured` now flips a frame late

The old rule suppressed the height transition until both layers had been measured, and set the
flag in the same layout effect that wrote the heights. That worked when the height was an inline
pixel value; it does not when the height is a `calc()` over two registered custom properties,
because **a transition's properties are taken from the after-change style**. Setting the real
pair and `data-measured="yes"` in one style recalculation therefore animates the panel from the
stylesheet's fallback to the truth, on arrival, in front of a rider who has just pressed Start.
`useHudDrag` arms the flag in a `requestAnimationFrame` after the first measurement instead.

---

## 2 · The sheet reopened on a view the rider had not asked for

`openForPlan` re-derived the view from the plan every time: a chosen route meant the detail,
anything else meant the comparison. That sounds right and is wrong the moment the rider has
already said otherwise — choosing a route does **not** leave the comparison (that is phase 11's
decision, and a good one), so a rider weighing three cards with one ticked would minimise the
sheet to look at the map, pull it back up and land on that route's climb list.

`viewOnOpen(view, plan)` keeps the view it was put away on, with exactly one exception: the
detail with no chosen route to describe, which is reachable because clearing a choice does not
close the sheet. Pure, and tested at both branches.

Scroll position inside the view survives too, because the sheet stays mounted. That is the same
argument — a rider halfway down a climb list who glances at the map is not asking to start again.

---

## 3 · Saved's detail carried two ways back

The screen's header has a `‹` that goes back to the map. The detail behind a row drew a second
one — `‹ Saved`, an inch below it — that went back to the list. Two back arrows at one level,
doing different things, with nothing on screen to say which was which.

`SavedScreen` owns `openId` now, so its one arrow goes to whichever is behind: the list while an
entry is open, the map when it is not, with the label to match. `RouteLibrary` takes the pair as
props and `EntryDetail` lost its `drawer-head` block entirely. The rule this leaves behind is the
general one: a screen's header owns the way out, and a view inside it does not get a second.

---

## Verified

`npx vitest run` — 718 green, from 715 (`hudDrag.test.ts`, 8; `routeSheetView.test.ts`, 3).
`tsc -b` and `npm run build` clean.

`tools/drive.mjs` gained three things, driven at a true 390 px against a seeded plan: `dragHud`
and `releaseHud`, which dispatch the pointer sequence and leave the finger down so the half-open
frame can be photographed at all; a minimise-and-reopen round trip on both sheet views; and the
Saved detail plus the trip back out of it. The frames that matter are `19b` (the panel half
dragged, the graph arriving, nothing doubled), `17b`/`17c` (the sheet reopening on the detail and
on the cards), and `11c`/`11d` (one arrow, and where it goes).

## Not done, and what a desk cannot answer

1. **Still not ridden.** Phases 7–13 are now all unridden, and this phase changes a gesture made
   *while moving*, which is the hardest kind of thing to judge at a desk.
2. **Whether the drag is the right weight with gloves on a rough road.** `FLICK_PX_PER_S` and
   the half-way settle are inherited from the sheet, which is used stationary. If the panel
   turns out to be easy to open by accident while steadying the phone, the answer is a larger
   commit distance before the drag takes — the same `pendingVerdict` shape the sheet's body
   uses — not a smaller target.
3. **Whether iOS sends `pointercancel` into the middle of a fold.** Handled (it settles back to
   where the gesture started), exercised only in headless Chrome.
4. **Whether the hand-over fade reads as a fade rather than a flicker on a 120 Hz screen.** The
   panel is briefly near-empty around `--hud-p: 0.5`; at 300 ms that is about 30 ms.
