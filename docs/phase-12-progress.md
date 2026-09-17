# Phase 12 — what the first riders found

Implemented 2026-09-17, from a list of things the user and their friends hit on real rides, plus
a set of mockups for an offline place search (`Free Wheel Redesign-selection.png`, cards 4a–4f).

Seven changes. Two of them are new machinery; the rest are the app finally doing what it looked
like it already did.

---

## 1 · The open sheet could only be dragged by a 60×24 pixel handle

The plan sheet is one surface with two stops and everything about it is a `calc()` over
`--sheet-p`. Closed, the card's whole background drags. **Open, the card behind it is `inert` and
the handle was the only thing left** — a target you have to look at to hit, on the one surface in
the app designed to be used without looking.

Two changes, and they answer different halves:

- **The handle grows with the sheet.** Its width and height are `calc()`s over `--sheet-p` like
  everything else here: 60×24 closed, and the full width of the sheet by `--sheet-head-open`
  (40 px) open. It sits exactly in the room the open layer's padding leaves above its content, so
  it covers nothing — the previous 24 px handle already overlapped the top of the card by 6 px.
- **The scroller drags too.** A press inside `.drawer-body` starts *pending*: nothing is
  captured, nothing is written, and `pendingVerdict` decides on the first dozen pixels whether it
  was a drag downwards, a scroll, or a tap on the route card under the thumb. It is only offered
  at `scrollTop === 0`; below that, pulling down means "back to what I scrolled past".

### `.drawer-body` had no `touch-action`, and the comment said it did

`.plan-sheet` sets `touch-action: none` — it has to, or the browser claims the drag — and the
comment beside it says "the scroller inside it hands `pan-y` back". No rule ever did. At a desk
that is invisible (a wheel scrolls regardless); on a phone it is a route list that will not move.
Added.

---

## 2 · The first run looked like a carousel and was not one

Six cards on one translated track, with a row of pips underneath saying how many there are and
which one you are on. Every part of that says "swipe me" and the only way through was the Next
button. `swipe.ts` is the same pending-gesture shape as the sheet's, transposed: `swipeVerdict`
decides which axis won (the cards are `overflow-y: auto`), `swipeOffsetPx` damps a pull past
either end rather than deadening it, and `swipeRelease` settles at 28% of the viewport or on a
flick. The buttons stay — they are the accessible path and the only one a keyboard has.

---

## 3 · A reroute threw the ride away

**The one that mattered most.** Off-route rerouting asked the engine for a line from the rider's
current position to the finish and made that the whole plan. Arithmetically that is the right
question. Twenty-two kilometres into a fifty-kilometre loop it is wrong in every figure on the
screen at once: the trip becomes 28 km long, the progress bar goes back to zero, the climbing
done falls to nothing, and the start point moves to a layby.

`stitch.ts` joins the road already ridden to the road just computed:

- `riddenPrefix(geometry, route, alongM)` cuts the old route at the point the rider left it,
  **interpolating** the cut rather than snapping back to the last vertex.
- `stitchRoute(prefix, fresh)` concatenates, and adds the figures: the prefix's from the geometry
  the app built, the suffix's from BRouter's own summary. Time is *pro-rated* over the prefix
  rather than added, because a GPX carries no per-point time to slice.
- The straight-line gap between where the rider left the route and where they are is counted. It
  is why there was a reroute, and the drawn line shows it.

The plan's waypoints do the same thing. `splitWaypoints` replaces `waypointsAhead` — one function
returning both halves, so the two can never disagree and send a rider back through a via they
have passed — and the rebuilt plan is *the original start, every via already passed, the rider's
current position, and what is left*. The injected point carries `kind: 'reroute'` and is drawn as
a 16 px dot rather than a numbered pin, and it does not shift the numbering of the points the
rider placed.

### `resumeAtM` is the part that is easy to leave out

`snapToRoute` searches a window around a hint and only falls back to a global scan, precisely
because a route that crosses itself is two coincident lines and a blind scan picks between them
by floating-point luck. **A stitched route's first half is a road the rider has already been
down.** So the stitched route carries the distance at which the rider rejoined it, and
`useRideTelemetry` seeds its hint with that instead of clearing it. Without this, the first fix
after a reroute on an out-and-back can put the rider back where they were an hour ago.

### A second GPX writer, deliberately

`stitchedGpx` is the third writer in the repo after `FormatGpx` and `traceToGpx`, and the rule
against one still does not apply for the same reason it does not apply to a recorded ride: that
rule protects the byte-for-byte parity corpus, which covers what the engine computed. A stitched
route is two engine outputs with a join in the middle. It is written in `FormatGpx`'s own shape,
so `parseBrouterGpx` reads it back and a stitched route saved to the library behaves like any
other — that round trip is asserted.

### What it does not do

**A stitched route's elevations are whatever the two halves had.** Following a recorded track
that was itself recorded partly off-route, and then rerouting, gives a profile with a flat
stretch in it where nobody ever measured a height. That is pre-existing behaviour for recorded
tracks (`RouteGeometry.hasElevation` is `some(e => e !== 0)`) and stitching does not make it worse
in kind, but it is the one place the join is visible.

---

## 4 · Searching the maps that are already on the phone

The largest piece of new machinery, and the one thing the app was carrying the data for and not
using.

Each region's basemap archive has names on its places, its POIs, its roads and its water, and the
app only ever used them to write words on the map. Measured against `edinburgh.pmtiles`:

| | |
|---|---|
| z14 tiles scanned | 2,760 |
| bytes read | 21.6 MB |
| scan + decode, on a laptop | **285 ms** |
| named features found | 51,038 |
| entries after clustering | 34,927 |
| packed index | ~0.9 MB |

### Where it runs, and why there

**In the engine Worker.** OPFS permits one open sync access handle per file, the engine's registry
owns every one of them, and `CLAUDE.md` forbids opening one anywhere else. Reading the archive
where the handles already are also means the reads are synchronous — the alternative is 2,760
round trips across a thread boundary through `readRange`.

It blocks the Worker for a few seconds, like a route does. `searchStore.hold(true)` stops it for
the length of a ride: the next thing that Worker might be asked for is the reroute that gets a
lost rider home.

### The deepest zoom, and only the deepest zoom

Protomaps repeats a feature at every zoom from its own `min_zoom` upwards, so the archive's
maximum zoom carries everything. Any shallower level silently misses the streets, which are most
of what a rider types.

### Clustered, not deduplicated

A road is cut into a segment per tile and every one carries the name, so "Ferry Road" arrives
forty times — and there are sixty High Streets in the Central Belt, which are sixty different
answers. Occurrences of one name are grouped and then clustered by distance, with a radius per
category: 0.7 km for a POI, 2.2 km for a place, 5 km for a road. Five kilometres puts a long
A-road into a few results along its length, which is both honest and useful.

### One enormous string, not a trie

The index is `'\n' + name + '\n' + name + …`, folded (case, accents, punctuation-as-word-boundary,
apostrophes deleted). A search is `indexOf` in a loop over ~600 kB — a native scan, faster than
the keystroke that triggered it — with a binary search over the start offsets to turn a match
position back into an entry. It is a few dozen lines instead of a data structure with its own
failure modes. **There is no debounce**, for the same reason.

Ranking: match quality (exact > prefix > word > substring), then category, then a *logarithmic*
distance penalty. Logarithmic because the difference between 1 km and 5 km is most of what a rider
means by "near me" and the difference between 60 and 64 km is nothing; tuned so a prefix match
40 km off still beats a buried substring down the road, and two equal matches sort by which is
nearer. Landuse-ish POI kinds — 1,249 farmyards against 118 pubs in the Edinburgh extract — carry
a penalty so they can never sit above the thing with the same name a rider actually meant.

### Two sources of duplicates, not one

The published regions overlap generously, so a rider with two neighbours installed gets Edinburgh
from each. And **one place is often filed twice inside a single archive**: Portobello is a
`places` neighbourhood and a `pois` place 400 m apart, which produced two rows with the same name
and different words under them. `mergeHits` therefore matches on name and position only, and the
category is deliberately not part of it.

### This is still not a geocoder

The rule in `CLAUDE.md` stands: nothing turns a position into a name. A waypoint the rider *chose
by name* keeps that name — `Waypoint.label` — because being handed a list and picking a row off it
is the other direction, and it costs nothing. A waypoint tapped on the map still shows its
coordinates to four decimal places, and "Start where I am" says *My location* rather than guessing
at a neighbourhood.

**This is worth revisiting.** The index makes offline reverse geocoding genuinely possible — the
nearest `place` entry to a coordinate is a lookup, not a network call — and the mockups show place
names where the app shows coordinates. It is left undone because the rule is written down and
reversing it is the user's call, not a change to make while implementing something else.

### Where it is stored

Its own IndexedDB database, `free-wheel-places`. The route library's database holds things a
rider made by hand and would be upset to lose; an index is derived, ~0.9 MB per region, and worth
nothing if it is slightly out of date. Keeping them apart means a corrupt index can be thrown away
wholesale without a version bump on the store holding a rider's rides. Freshness is by **archive
byte count**, not a hash: the mirror is content-addressed, so an update is a different length, and
hashing 34 MB to answer a question the size already answers costs seconds on every launch.

---

## 5 · A gazetteer, for one screen

A search with no results looks identical to a misspelling, to a made-up place, and to a broken
app. So `public/gazetteer.json` ships 1,822 British towns — **48 kB** — and an unmatched query gets
"Aberystwyth is in North Wales", the size of that download and a button that starts it. That is
`explainRoutingFailure`'s move, on the screen a rider reaches first.

Built by hand with `tools/build-gazetteer.mjs` from a Britain-wide z10 extract and committed, like
the engine and the profiles. The cutoff is `min_zoom <= 10`, which is Protomaps' own judgement
about what is worth labelling at that scale and a far better definition of "a town somebody would
type" than a population threshold. One step deeper is 15,458 places and 300 kB precached on every
phone, to answer a question the region's own index answers better once it is downloaded.

`regionAt` is new in `regionShapes.ts`: the partition's own rule — nearest seed among the regions
whose published box covers the point — asked about one point instead of 36,000 cells.

### The mockup's round trip is not built

Card 4d offers "Round trip back here". A loop needs a via or a generator; routing a start to
itself gives BRouter a degenerate problem and the rider a zero-length route. Left out rather than
shipped broken.

---

## 6 · Saved places, and the four small things

- **Saved places and recents** live in `localStorage`, which is the route library's argument run
  the other way: forty bytes each, and the search screen's first paint is a list of them — a list
  that arrives a frame late is a list that jumps. `iconFor` guesses the two names every rider
  saves (Home, Work) and stars the rest.
- **Clearing a route** was the first complaint: *Clear route* lived at the foot of the comparison
  view, inside a sheet you had to know dragged open. The field at the top of the map now carries
  the plan — `Charing Cross → Brighton Pier` — and a × beside it. It is still in the sheet too,
  because that is where you are when you decide a route is wrong.
- **Which mode you are in.** The bar along the foot of the riding screen was a `.panel`:
  translucent white, exactly like the plan card it replaces. It is a filled `--mode` surface now,
  with a live dot and the word *Riding*, against a planning screen that carries a white card and a
  search field. See below for why `--mode` is the one role token that does not invert.
- **Ride history.** `rideTotals` adds up the month and all time — distance, climbing, moving time,
  how many — above the *Ridden* filter, where it is the answer to the question that filter asks.
  Counted by `summary.startedAt` rather than `savedAt`: a ride belongs to the day it was ridden.

Also: **Reverse now routes what it reversed.** Its doc comment has always said so and the code
only cleared the line, leaving the rider on a plan card inviting them to tap the map — and the new
search screen's swap button has no Find routes button at all, so from there it was a dead end.

---

## 7 · Two things the search flow needed that the tap flow never did

### One plan, two ways to get a second point into it, and two runs

The ride screen fired a route on the **transition from one waypoint to two**, and that guard
cannot tell where the second point came from. A plan built from the search asked for its own run
(it has to — a rider who replaces the finish on an already-routed plan produces no transition at
all), so a search-built plan fired *both*: two simultaneous BRouter searches for the same route,
at the one moment the rider is watching a spinner.

`useRoute` owns "this needs routing" now — `addWaypoint` and `placeAt` both set the flag, and an
effect consumes it once the waypoints have committed, because `run` closes over `waypoints` and a
caller that has just replaced them is holding the previous plan. The ride screen keeps only the
half that is genuinely a screen's: opening the sheet onto the cards.

A `runSeq` token came with it. A run is seconds of `await`s, and picking a new destination,
reversing or clearing all replace the waypoints it was computed for; a result landing afterwards
would draw a line between two places that are no longer the plan. Each of those bumps the token
and a superseded run commits nothing — including not taking the spinner off the run that
replaced it.

### The map has to move when a place is chosen by name

Tapping the map never needs this: you are already looking at the place. Picking Portobello off a
list does, and the route's own `fitBounds` cannot do it — that only runs once there is a line, and
the two interesting moments are before it (one end chosen) and instead of it (routing failed for
want of road data).

The fit also has to clear the sheet. A second point completes the plan, which opens the sheet onto
the route cards; framing against the whole viewport put both pins behind it — measured at y 342
and 392 on an 844-high screen whose sheet starts at 345. `sheetClearance` reads `--sheet-open`,
which is the open layer's own measured height, and clamps it so `fitBounds` is always left
something to fit into.

`framePicked` is deliberately **not** in the waypoint effect. A tap on the map must never move the
camera — that is a rider placing a pin and having the ground slide out from under the next one.

---

## 8 · Two measured things that were not obvious

### `--mode` does not invert, and the test is why

`--ink` was the obvious fill for the riding bar and is wrong on the dark theme for exactly the
torch-in-your-face reason that theme exists. `--slate-700` was the obvious dark answer and
measured **ΔE 6.9** from the card it is supposed to be distinguishable from. It is a deep green in
both themes — `#12342a` light, `#143d2e` dark, a shade lighter because the page under it is darker
— which is also the colour of the live dot on it and of the location dot on the walkthrough.
`chrome.test.ts` asserts both halves: 4.5:1 for the figures on it, 3:1 for the fix line, and
ΔE ≥ 20 from the card.

### `overflow: hidden` on a grid item makes it squeezable

`.place-list` rounds its first and last rows against the card with `overflow: hidden`, which also
makes it a **scroll container** — whose automatic minimum size is therefore 0 rather than its
content. The grid row in `.screen-body` was then free to compress it: twenty-one results laid
themselves out 692 px tall over 1,417 px of rows, clipped the rest, and reported to the scroller
that everything fitted (`scrollHeight === clientHeight`). `min-height: min-content` on the list
plus `grid-auto-rows: max-content` on the body fixes both halves — without the second, the footer
under the list was given no height at all and drawn across the middle of it.

Any long list in a `.screen-body` is exposed to this. `.library-list` is not, only because it has
no `overflow: hidden`.

---

## Verified

`npx vitest run` — 707 green, from 627. New coverage: `stitch.test.ts` (13),
`placeIndex.test.ts` (19), `places.test.ts` (11), `swipe.test.ts` (12), `buildIndex.test.ts` (3,
against the real Edinburgh archive, skipped where it is absent), plus `splitWaypoints`,
`withEndpoint`, `rideTotals`, `pendingVerdict` and the two new `chrome.test.ts` assertions.

`tools/drive.mjs` gained `FW_ARCHIVE=<path>.pmtiles`, which imports an archive through the app's
own manual-import path and then drives the search against it. That is the only way to see this
feature work at all — the index is built in the engine Worker out of OPFS, so a seeded fixture
would exercise none of it. Driven at 390 px in both themes: the search's empty state, live results
for a place and for a street, the not-downloaded card for Aberystwyth, the aiming strip, the
riding bar, and the sheet at its new open handle size.

## Not done, and what a desk cannot answer

1. **None of this has been on a road.** Phases 7–12 are now all unridden. The acceptance test is
   unchanged: airplane mode, cold launch from the Home Screen, plan a route, follow it.
2. **How long the index build takes on a phone.** 285 ms on a laptop; a phone is a few times
   slower and the OPFS reads are real. If a region takes 30 seconds rather than 3, the progress
   line in the search screen is the thing that has to earn its place.
3. **Whether a reroute actually keeps its figures on a real wrong turn.** The arithmetic is
   tested; what is not is whether the stitched line looks right on a map at street zoom, and
   whether the rejoin dot reads as "the route goes through here" rather than as a stray pin.
4. **Whether the results are the right results.** The ranking is tuned against Edinburgh and one
   rider's intuition. "High Street" and "Station Road" in a town with four of each is the case to
   watch.
5. **Whether the sheet's body-drag fights the scroller on iOS.** Safari sends `pointercancel` when
   it takes a gesture over for scrolling, which the pending path treats as "not ours" — that is
   the intended behaviour and it has only been exercised in headless Chrome.
