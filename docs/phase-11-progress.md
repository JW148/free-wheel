# Phase 11 — the redesign

Implemented 2026-09-14 from the Claude Design handoff bundle (`Free Wheel Redesign - Final.dc.html`,
turn 1; plus turns 2 and 3 of `Free Wheel Redesign.dc.html`). The design spec, and the seven
decisions taken with the user before any code was written, are in
`docs/superpowers/specs/2026-09-14-ui-redesign-design.md`.

Three changes, and only the first is a restyle.

## 1 · The chrome went light, and the dark theme became a re-mapping

`src/tokens.css` is new and holds every colour, shadow and radius in the app as a **role token
with a value per theme**. `<html data-chrome>` selects between them, set from the same state
that picks the basemap palette — so the map and the chrome are never one theme apart. The
basemap's own default flipped to `light` with it; a rider who had already chosen dark keeps it.

Two things that were not obvious going in:

- **`ride.css` had its own `:root` block** redefining `--panel`, `--panel-strong`, `--panel-row`
  and `--hairline`. It is imported after `index.css`, so it won a cascade nobody knew was
  happening. Removed; the tokens live in one file now.
- **Shadows are structure, not decoration.** The dark app had none, because a slate panel
  separates from a slate map by being lighter. On `#f6f5f1` a white card has no edge at all
  without one. Four are defined and there is no fifth.

The old token names (`--bg`, `--surface`, `--raised`, `--text`, `--rule`) survive as aliases, so
a rule that had not been revisited still landed on the right colour in both themes while the
redesign moved screen by screen.

## 2 · Two taps, three routes

The tick-list-and-Compare flow is gone. The second tap on the map routes automatically and
produces three cards named in the language a rider uses:

| Engine id | `label` | `plain` |
|---|---|---|
| `trekking` | Trekking | **Relaxed** |
| `fastbike` | Fast | **Fast** |
| `gravel` | Gravel | **Off-road** |

The other three profiles are behind *More riding styles*; nothing was removed. `profiles.ts`
carries both names, and the engine's own name still appears — in the detail view's pill, which
is the one place a rider can usefully meet it.

**`plan.chosen` keeps its exact meaning.** It is `null` until a card is tapped. That nullability
was a bug fix in phase 5 and every reason for it still holds.

### The distance guard

Three routes is three sequential BRouter searches, because the Worker blocks inside Wasm.
`COMPARE_CEILING_M` is **50 km of air distance** — a third of `AIR_DISTANCE_CEILING_M`, and
deliberately not the same number: that constant is where *one* route gets uncomfortable, this is
where *three* do. Past it, only the rider's own style runs and the other two cards offer to
compute themselves on a tap.

Results are also committed to state **as they land** rather than all at the end, and the rider's
preferred style goes first. The first card fills in while the second is still computing, which
is the difference between a list assembling itself and a spinner.

`profilesToRun` and `airDistanceM` are pure and tested at either side of the ceiling
(`compare.test.ts`), including the two cases that would be silent failures: a lone profile must
never be deferred (it would leave a rider past the ceiling with no route at all), and a
`preferred` style that is not in the selection must not be added back — which happens whenever a
saved route collapses the selection to the profile it was computed with.

## 3 · A first run, in pixels

Six cards, shown once, under their own storage key (`free-wheel.onboarded.v1`) — deliberately
**not** the maps gate's. They answer different questions: the walkthrough is "what is this app",
the gate is "this phone has nothing to ride on". A rider who deletes every region to free space
meets the second and would be insulted by the first.

The art is six glyphs on the same 20×14 grid as the app icon, in its own two greys plus the
trekking amber, written as character maps in `onboarding/glyphs.ts` and rendered to a CSS grid.
The design's first option was six photographs: handsome, generic, and about a megabyte of
Wikimedia CC BY-SA assets to license and commit in an app whose whole point is that it works
with the network off. The bundle's own turn-3 note argues for the pixels.

**One glyph was redrawn after looking at it.** Two whole bikes side by side read as a pair of
spectacles at twenty cells across — two frames is about six pixels of bike each and the wheels
merge into lenses. It is now two wheels, one slick and one knobbly, with the amber spent on the
tread.

The bike question sets three things: the suggested route style, the riding position and the
tyres. The last two are the largest error terms in the flat-ground power estimate and are
otherwise buried in a settings screen nobody opens. A mountain bike maps to the **off-road
card** rather than to the `mtb` profile — the three cards are a fixed vocabulary, and `mtb` is
one tap away.

## What else moved

- **The rail of seven buttons is two.** Placing and the saved list went into the plan card;
  daylight, path mode and follow went into a Layers sheet. The collapse chevron went with them:
  it was a control for a control, and two buttons need no machinery to put away.
- **The waypoint-placing toggle is gone entirely.** The plan card names every point and gives
  each an explicit `×`, so a stray tap is one tap to undo and visible the moment it happens —
  while the toggle was a mode you could be in without knowing. Riding still refuses map taps.
- **Saved is a screen**, and its rows open rather than carrying Delete a thumb-width from Load.
- **Setup is a list that pushes**, not three tabs. Diagnostics is a footer link and still
  reachable, because the parity check is the regression net.
- **Ending a ride is a 700 ms hold**, with a fill that tracks it. Same argument the repo already
  makes about text fields on the riding screen: a tap is a gesture a pothole can make.

## What the browser found that the tests could not

`web/tools/drive.mjs` drives the built app in headless Chrome at a true 390 px. It is not a
test — it is a way to *look* at the thing — and it earned its keep twice in one pass:

1. **The old stats rail was still painting** distance/moving/climbing over the map after the
   route cards took those figures over. It only showed once a route was chosen, behind the
   sheet's scrim, which is why nothing caught it.
2. **Every stat block in the app rendered its label above its value.** `flex-direction:
   column-reverse` over markup of `<dd>` then `<dt>` does the opposite of what the comment
   beside it claimed, and had done since phase 4. The markup is now in the correct order for a
   description list and the figures read the way the designs draw them.

The four traps recorded in the repo's notes all still apply and are worked around in the script:
the service worker serving the previous build, a headless tab never firing `requestAnimationFrame`
(which MapLibre's style loader awaits, so the map silently never loads), one app tab at a time
because OPFS allows one sync handle per file, and `--disable-gpu` killing WebGL2 outright.

## What the phone found that the browser could not

Three things, from the first run on a real iPhone in standalone. All three are fixed; each is
here because the desk could not have shown it.

### The pinned Start ride was not pinned

`.drawer-footer` was a `position: sticky` child of the scrolling drawer body. Sticky cannot be
pushed outside its **containing block**, and the containing block ends at the scroller's own
bottom padding — `--safe-bottom`, the home indicator's clearance. So the button stuck itself
that far above the true bottom, and the climb list scrolled through the strip underneath it in
plain view. A `margin-bottom: calc(var(--safe-bottom) * -1)` had been written to bleed past that
edge; the clamp ignores margins and it never did anything.

It is invisible at a desk because `env(safe-area-inset-bottom)` is 0 in a browser, which makes
`--safe-bottom` 12 px and the leak a hairline. On the phone the inset is 34 px, so the strip is
46 px and a whole row of buttons scrolls through it.

The footer is now a **sibling of the scroller**, laid out by the drawer's own flex column.
Nothing scrolls behind it, so it needs no background to hide what does — and the body drops its
bottom padding when a footer follows it, via `.drawer:has(.drawer-footer)`.

### The map credit sat on the plan card

The OSM attribution is a licence requirement, and it was positioned bottom-left at a constant
`5.7rem` above the safe inset, with a second constant for riding. Both were guesses and both
were wrong: the plan card measures **164 px** once a route is chosen, so the credit landed
across the route's own name.

No constant could have been right. The card is an invitation, a pair of coordinates or a routed
summary with a Start button, and the riding bar is one line or two — four heights, and the card
changes between them under the rider's thumb. So `useBottomBarHeight` measures whichever bar is
on screen (they carry `data-bottom-bar`) and publishes `--bar-height`; the stylesheet's constant
survives only as the value before the first measurement. Same argument as the HUD's measured
height, and the second time this app has reached for it.

### There was no way to Setup with a plan on the map

Setup was reachable from the plan card's shortcuts and from nowhere else, and those shortcuts
are the card's *empty* state. Place one waypoint and the only door to the regions, the rider and
the diagnostics closes — for as long as there is a plan. The rider who most needs to download a
region is the one part-way through planning a route into a region they do not have.

It is a row at the foot of the Layers sheet now, below the note that closes the map group, with
the chevron Setup's own menu rows use. That sheet is behind one of the two buttons that never
leave the map and is already the surface for things you set rather than things you do; the
button's label widened to match. The plan card keeps its shortcut — it is still the fastest way
in from a cold start.

## The contrast measurements

`src/chrome.test.ts` is new. The dark app never needed it — a light-grey label on near-black
passes every contrast rule without anyone thinking about it. Light chrome does not, and four
colours chosen against slate did not survive the move:

| | Measured | Floor | Now |
|---|---|---|---|
| `--faint` on `--page` | 2.78:1 | 3:1 | `#828d94`, 3.11:1 |
| `rising` band on the panel | 2.27:1 | 3:1 | `#aa8f3e`, 3.13:1 |
| `steep` band on the panel | 2.84:1 | 3:1 | `#c47438`, 3.56:1 |
| dark `--good` on `--good-bg` | 3.88:1 | 4.5:1 | `#61ab6b`, 4.50:1 |
| dark `--bad` on `--bad-bg` | 3.72:1 | 4.5:1 | `#da7c87`, 4.51:1 |

The gradient bands are the interesting one. A bar has to clear 3:1 against **white** *and*
against **`#11212d`**, which confines every band to a relative luminance between about 0.14 and
0.30 — a window of roughly 2:1. Four of the six were already inside it; three were pulled to a
target luminance with their hue and saturation untouched.

Two rules had to survive that, and one of them was nearly lost. Scaling two bands to the same
contrast target lands them on the same luminance — `rising` and `steep` came out 0.2591 and
0.2592, which destroys the severity ramp. The test now asserts three things separately: every
band clears 3:1 on the panel, every adjacent pair clears ΔE 10, and the four *climbing* bands
darken in order. `flat` is deliberately excluded from the third: it is not a severity, and it
sits between `rising` and `steep` by luminance on purpose.

A rule that was written and then withdrawn: **monotonic luminance across all six**. The scale is
read by hue — yellow, orange, red, magenta — at roughly held lightness, which is the standard
cycling convention and what the original six did. Imposing a full lightness ramp was an
invention, and it is not one the design or the original ever made.

## What the design asks for and this does not do

- **The map-based region picker (1i, 2c).** Excluded by the user. Those mockups draw bounding
  boxes over a streamed map of Britain; the app paints a *partition* clipped to the coast by the
  basemap's own water, which is better and was expensive to get right. `regionShapes.ts`,
  `regionLayers.ts` and `BrowseMap.tsx` are untouched. Only the sheet over them is redesigned.
- **A Rename row on the finish sheet (1g).** It cannot go there: a text field on the riding path
  is what summons iOS's "Undo Typing" alert, which a page has no way to decline. The ride saves
  itself under a generated name and renaming stays in Saved.
- **Place names on the plan card (1c).** The mockup reads "Princes Street, Edinburgh". There is
  no geocoder on this phone and there is not going to be one — reverse geocoding is a network
  service. The card shows coordinates to four decimal places, about 11 m.
- **`Start ride · Relaxed` on the compare sheet (1d).** The design has a route committed at all
  times. This app's `plan.chosen` is `null` until the rider picks, and that is load-bearing.

## Not done

**The ride.** Everything above was verified in headless Chrome at 390 px in both themes, and by
615 unit tests. None of it has been on a phone. The questions a desk cannot answer:

1. **Is a white panel legible in sunlight**, and is the dark variant the right answer after
   dark, or should the chrome default from the basemap theme rather than being a preference?
2. **Is 700 ms the right hold** with gloves on, on rough ground?
3. **Does the sheet motion judder** over a moving map? Backdrop-filtered surfaces animating on
   iOS is a failure this repo has hit once already, on the control rail. If it does, the
   expanded sheet loses its blur and becomes opaque — it covers the map anyway.
4. **Does the second tap routing three profiles feel fast or slow** at a realistic distance, and
   is 50 km the right ceiling? It is a guess until it is ridden.
5. **Are the darkened gradient bands still readable at a glance**, or did clearing white cost
   more than it bought on the dark theme?
