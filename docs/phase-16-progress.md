# Phase 16 — what the road is made of, and where to turn

Implemented 2026-09-19. Design in
`docs/superpowers/specs/2026-09-19-route-surface-and-turns-design.md`.

Two features that look unrelated and are one change. BRouter already knew the surface of every
metre of every route, which class of road it was, whether it was on the National Cycle Network,
and which way to turn at every junction. It has known all of this since phase 1. None of it
reached JavaScript, because `Router.java` asked `FormatGpx` for the quietest output it has.

---

## 1 · The finding this rests on

`misc/profiles2/lookups.dat` is the tag vocabulary encoded into every `.rd5` tile, and it
carries `highway`, `surface`, `smoothness`, `tracktype`, and `route_bicycle_icn` / `ncn` / `rcn`
/ `lcn`.

That last group is worth stopping on, because `docs/phase-5-progress.md` concluded that cycle
network data is absent and **was right — about the basemap**. Protomaps ships no `route=bicycle`
relations at all. The routing tiles are a second dataset on the same phone, and they know
network *membership*. Not the number: the app can say "2.1 km on the National Cycle Network" and
can never say "NCN 1".

The tags cost nothing to obtain. BRouter routes in two passes — the search, then a second pass
driven by the found track as a guide — and that second pass runs in detail mode, which is what
creates the `MessageData` the tags live on. They were being computed and thrown away.

## 2 · One flag, both features

`turnInstructionMode = 9` is the only mode `FormatGpx` emits both `<brouter:way>`, the decoded
tags at each change, and `<brouter:voicehint>` with a `<sym>`, the turn command at each
junction. So the surface breakdown, the map's marks and turn-by-turn are one engine change.

Set **after** the `RoutingEngine` constructor, never before. The constructor calls
`ProfileCache.parseProfile`, which calls `rc.readGlobalConfig()`, which assigns
`turnInstructionMode` from the profile's own global variables — zero, for every profile shipped
here. Set it first and it is silently reverted and the GPX comes back with no extensions at all.

Everything is in `engine/src/main/java/btools/wasm/Router.java`, which this repo owns. Nothing
under `brouter-link/`, no fork, no second output format.

## 3 · The corpus runs both modes

Parity was never at risk. `jvmRoutes` calls the same `Router.routeIn` the browser calls, on
purpose, so a mode change moves both sides identically. What went stale was the recorded byte
lengths and CRCs.

Twenty entries now: every case at mode 0 and at mode 9. Mode 0 stays because it is what any
other BRouter client would produce, and a divergence there is worth catching too.

**Mode 9 is not slower.** Measured on the JVM:

| case | mode 0 | mode 9 | GPX 0 → 9 |
|---|---|---|---|
| `urban-short` | 170 ms | 90 ms | 8.6 kB → 23.1 kB |
| `london-brighton` | 2021 ms | 1829 ms | 236 kB → 443 kB |
| `cross-tile-long` | 1913 ms | 1914 ms | 289 kB → 534 kB |

The differences are warm-up noise. The spec carried a 25% threshold and a documented fallback
(comparison at mode 0, the chosen route re-run at 9); neither is needed and the fallback was not
built. **GPX roughly doubles**, which matters only for the library's IndexedDB records.

### A tenth case, so parity can actually be checked

The corpus was all southern England, which meant checking it in a browser needed `W5_N50` and
`E0_N50` in OPFS — 215 MB through the file picker, which took **half an hour**. A check nobody
will run is not a check.

`edinburgh-short` is a tenth case — the 19th and 20th entries — inside `W5_N55`, the 26 MB tile
every driver script already imports. `tools/drive-parity.mjs` seeds that case's waypoints into the plan *reversed*,
presses the app's own Reverse button to route them in order through the same `toFixed(6)` path
a tap takes, and compares the GPX to the JVM's by length and SHA-256.

**Byte-identical**: 34,492 bytes, `7b098b9bfb7e2bfb…`, in about a minute. That is the check
worth having after a change to the output format, because mode 9 writes numbers the plain mode
never did — `VoiceHint.formatGeometry` casts floats to ints, and a float cast is exactly what a
translation gets subtly wrong.

It proves **V8** against HotSpot. The handoff's claim is about **JSC**, and only a phone settles
that; the Diagnostics panel replaying all twenty is still the right tool there.

## 4 · Reading it back

`gpx.ts` keeps its regexes and its reasoning. One pass over the track points, one counter, so
the ways and the turns are numbered against the same coordinates they describe.

Positioned by **track point index**, not by distance. Converting to metres needs a cumulative
array, `routeGeometry` already builds and caches one, and two measurements of the same route are
two things to keep in step. `ways.ts` and `turns.ts` do the conversion.

Both arrays are `undefined` rather than `[]` on a mode 0 route. Absence and emptiness are
different facts here and everything downstream branches on it: a recorded ride cannot describe
its surfaces at all, where a route straight down one road genuinely has no turns.

`<sym>` is parsed and `<desc>` ignored. The token is stable and enumerable; the prose is
BRouter's English, and the app writes its own sentences.

Two things the fixtures caught that reasoning had not:

- **`<trkpt lon=".." lat=".."/>` is a real shape** — a point with no elevation and no
  extensions — and a pattern insisting on `</trkpt>` read a whole such document as having no
  track points at all.
- **Britain drives on the left**, so every roundabout from London to Brighton comes back
  `RNLB`, never `RNDB`. The first test asserted the wrong one.

## 5 · The taxonomy, and two fallbacks that lean

`ways.ts`, following what `search/kinds.ts` does for place kinds. `unclassified` does not mean
unclassified, `tracktype=grade3` means nothing to anybody, and a wide shallow vocabulary
collapses into a handful of words.

Two fallbacks are asymmetric on purpose and both point the same way: **never invent a warning.**

- An untagged surface is `unknown`, not `paved`. The map marks unpaved stretches, and a guess
  there draws a claim about the world out of a gap in OpenStreetMap.
- A `highway` value the table has not seen is `road`, never `main`. The main-road mark is
  supposed to mean something the first time it is seen.

Tertiary is deliberately a `road`. A British tertiary is a lane, and calling it a main road
would mark most of the countryside.

Runs are measured against `routeGeometry`, not BRouter's `track-length`: they have to agree with
the elevation profile's x-axis and with `snapToRoute`, not with the summary line. **The first
run starts at 0** rather than at the first `<brouter:way>`, which lands on the second track
point because the first is the snap onto the network. The runs tile the route exactly, which is
what lets the table claim to total it.

## 6 · What it says about a real route

London to Brighton, 94.9 km, from the reference corpus:

| | |
|---|---|
| road | minor 43.5 km · cycle path 24.3 km · main 21.3 km · path 5.8 km |
| surface | paved 64.8 km · **not recorded 23.4 km** · unpaved 6.7 km · setts 0.02 km |
| network | **42.1 km on the National Cycle Network** |
| runs | 600, collapsing to 34 map marks |

The 42.1 km is NCN 20, which is the right answer and the confirmation that the network tag
works. The 23.4 km of unrecorded surface — a quarter of the route — is why `Not recorded` keeps
a row in the table and gets no mark on the map.

## 7 · Colour is free on a panel and spoken for on the map

`gradeScale.ts` already recorded the rule: chrome colours on a panel we control are exempt from
the C ≤ 15.4 stroke ceiling, because that ceiling exists to stop a route *line* being mistaken
for a road and nothing on a panel is on the map. That splits this feature cleanly.

**In the sheet**, full colour. A strip under the elevation chart on the same x-axis, coloured by
road class, plus a breakdown table whose road rows carry the same swatches — so the table is the
strip's legend and there is no third element saying what two already say.

What is not free is the contrast window, and `gradeScale.ts` recorded that too: 3:1 on white and
on `#11212d` at once confines every cell to a relative luminance of roughly 0.14 to 0.30, about
2:1 wide. Four classes cannot separate on lightness inside it, so they separate on hue at a held
lightness. Found by sweeping the RGB cube:

| class | hex | vs white | vs `#11212d` | L\* |
|---|---|---|---|---|
| cycle path | `#007b60` | 5.25 | 3.13 | 45.6 |
| path or track | `#7e694b` | 5.24 | 3.13 | 45.7 |
| minor road | `#5d6c8a` | 5.28 | 3.11 | 45.5 |
| main road | `#d80050` | 5.20 | 3.16 | 45.9 |

`chrome.test.ts` holds three floors, and **they are deliberately different numbers**: ΔE 18
between cells (worst measured 27.4), **13** against the gradient bands (worst 13.1, `main`
against `brutal`), 11 against the route colours (worst 12.0, `main` against `mtb`).

The 13 is a trade and is written down so it does not become folklore. The warm arc inside the
window is already occupied by `very steep`, `brutal`, `mtb` and `recorded`, and a red clearing
15 from all of them **does not exist** — the sweep returns a dusty rose at L\* 60.6, fifteen
points lighter than its neighbours, which reads as one pale outlier rather than as a warning.
What is risked at 13.1 is confusing a 10 px strip cell with an area chart's fill: two different
objects an inch apart, never adjacent, and the two nearest bands both mean "be careful" like the
cell does.

**On the map**, exceptions only, achromatic. Everything paved on a minor road gets nothing,
which is most of a British ride. Mark every metre and the line becomes noise a rider learns to
ignore; mark only what changes a decision and a dashed stretch means something the first time it
appears. A cycle path gets no mark either — it is the good case, the strip names it, and the
basemap's own `paths` layer already draws a cycleway solid where a track is dashed.

## 8 · The main-road mark, which driving the app rewrote

It started as extra weight *under* the route: a wider, darker casing, on the reasoning that a
heavier line reads as a bigger road. On the light theme it worked.

**On the dark theme it vanished completely.** The casing colour is `#06141b` and so is most of
the dark basemap, so it was a near-black mark on a near-black map. Every unit test was green
throughout, including the layer-order one; `drive-surface.mjs` in both themes is what found it.

It is now a pair of hairlines hugging the route on both sides, in the theme's overlay ink, via
`line-gap-width` — which is what road casings are drawn with, and the right association. It
cannot be confused with the climb halo, which is blurred, centred and much wider.

It also moved **above** the casing, and that is arithmetic: at z16 the casing is 13 px against
the line's 8, so flanks at a radius of 4.25 to 6.25 were being painted straight over.

## 9 · Turn-by-turn, and the volume problem

The data was never the hard part. The hard part is that London to Brighton has **322 junctions
over 95 km**, and announcing each twice the way a car satnav does is 644 utterances on a
four-hour ride — one every twenty seconds, which is an app muted inside the first hour, and a
muted app says nothing at all including the things that mattered.

Four rules bring it down, all pure and all in `turns.ts`, measured at each step:

| rule | effect |
|---|---|
| one utterance per turn, not a prepare and a now | halves it |
| `C` — BRouter's "ignore that turning" — never spoken | 37 of 322 gone |
| two turns within 120 m chained into one sentence | 59 pairs collapsed |
| **slight turns shown but not spoken** | **125 of 285 actionable junctions** |

The last one is the big one, and it was found by the cue walk failing its own bound. With slight
turns spoken the route produced **267 utterances, one every 54 seconds**.

Walked at 7 m a step — about 1 Hz at 25 km/h, which is the rate a real fix arrives at — the
finished rules give **138 utterances over 3.8 hours, one every 99 seconds.**

### The chained pair was being spoken twice

Found by an adversarial review of the branch, after the feature looked finished and the tests
were green. `turnToAnnounce` returns the turn and its chained partner, and `cueFor` keyed the
cue on the **first junction only**. Nothing ever marked the partner as said, so on the next fix
`turns.find(…)` found it again and announced it alone a few seconds later.

That is the exact failure chaining exists to prevent, and worse than not chaining at all:
`useAnnouncer` cancels rather than queues, so on a 29 m staggered crossroads the repeat arrives
while "Left in 100 metres, then right." is still speaking and clips it.

45 of 74 chained pairs did this. The fix is `Cue.covers` — the other keys a cue has already
answered for, marked said alongside its own — and it is worth **36 utterances**, taking the
route from one every 79 seconds to one every 99.

Both tests that should have caught it did not, and the reason is worth recording. `turns.test.ts`
only asserted the `{ turn, then }` *shape*. And the cue walk asserted that no key repeats —
which was true, because the repeat had a **different** key. The walk now consumes `cue.covers`
exactly as `useAnnouncer` does, and asserts that no covered key is ever also announced on its
own. It carries a `covered.length > 20` guard, because without one a `cueFor` that stopped
reporting `covers` at all would pass the loop vacuously.

A slight turn is mostly a road bending where another road joins. BRouter is right to emit one —
a decision technically exists — but a rider following a road round a curve does not need to be
told to follow the road round a curve. It is the same argument the climb rules already make:
"top of the climb" is spoken only for a climb hard enough that the rider was rationing, because
being told you have crested a railway bridge is what gets an app muted.

Two things make it safe rather than merely quieter. A slight turn is still **drawn**, with its
distance. And it still **chains** — "left, then bear right" costs no extra interruption, and a
fork immediately after a real turn is exactly where a rider would otherwise go wrong. Past both,
the off-route cue is the net.

**Timed, not spaced.** Fifteen seconds of warning, floored at 60 m. A fixed distance is two
streets early in town and arrives after the junction at 50 km/h downhill. The 400 m cap only
binds above 96 km/h, so it is a backstop for a bad fix rather than a path any ride takes.

**Priority**: off route, then turns, then arrival and the climbs. A missed turn *creates* the
off-route the app is about to announce, and a turn is the only cue with a deadline — a climb
announced late is still a climb coming up.

**No street names**, and not from this data. `lookups.dat` has no `name` key. Every instruction
is "left in 200 metres". The basemap archive does carry road names, so one could be recovered at
a turn's coordinate later — a lookup at a known point rather than a geocoder — but that is a
separate decision.

### On screen

The collapsed strip's one line goes to a turn inside 400 m and to the climb otherwise
(`calloutFor`, pure and tested). The horizons compare the opposite way round to the spoken ones
on purpose: a climb is worth knowing about minutes early because the decision is made minutes
early, where 400 m of "left ahead" stops meaning anything before you reach it.

The arrows are **computed from one angle** rather than drawn eleven times, so the set reads as
one family and the angles stay comparable. The angles are BRouter's own: 35°, 90°, 135°.

## 10 · What survives a reroute

Without this the app goes quiet at the exact moment a lost rider needs it: turn-by-turn stops
the instant you take a wrong turn.

A prefix is a *leading* slice, so every index it keeps means the same point it always did, and
only the suffix shifts — by the prefix's length. That is one line and it is the kind that fails
silently: get it wrong and the road ahead is described with the tags of the road behind, which
looks entirely plausible all the way down. Four tests hold it.

The cut uses `kept` rather than `coords.length`, because the interpolated cut point is pushed on
the end and is not an original index. `stitchedGpx` writes both back out, so a saved stitched
route reopens with its surfaces and junctions intact.

## 11 · What a desk cannot answer

In rough order of risk. **None of this has been ridden.**

1. **Whether 138 utterances over four hours is right.** Every number in §9 is a judgement made
   at a desk against a reference route. The two levers are the fifteen-second lead and the
   slight-turn suppression, and both could be wrong in either direction. Suppression is the one
   to watch: the failure mode is a missed fork on an unfamiliar lane, and it will feel like the
   app not telling you something rather than like a setting.
2. **Whether the dashed centreline is legible in sunlight** over all six route colours. It is a
   lightness effect over a saturated line, which is the arrangement most likely to disappear on
   the light theme in daylight — and the light theme has still never been outdoors.
3. **Whether the main-road flanks read as "main road"** or as a rendering artefact. They are
   deliberately quiet, and on a 7.7 km test route only 642 m carried them.
4. **Whether the strip is legible at 10 px** on a real screen at arm's length, and whether four
   hues at one lightness separate in sunlight the way they do on a monitor.
5. **Turn instruction cost on the phone.** Not slower on the JVM, unmeasured on device.
6. **GPX size, in two stores.** Twenty saved routes at 443 kB is 9 MB of IndexedDB, which is
   nothing against a ~60%-of-disk quota, but nobody has watched it happen.

   The other store is worth the arithmetic, because it fails silently. `plan.ts` drops the
   whole `gpx` map out of the stored plan when the total passes `MAX_STORED_GPX` (2 MB), so a
   cold start re-routes instead of redrawing. Doubling the GPX halves the headroom: three 95 km
   routes were 708 kB and are now 1.33 MB.

   It still cannot be breached by anything the app allows, and the reason is a constant nobody
   had this in mind when choosing. `COMPARE_CEILING_M` is 50 km, so three routes only ever
   exist below that — about 700 kB together — and past it a single route runs, which even at
   the 150 km air-distance ceiling lands near 1 MB. The margin is real but it is now one
   doubling wide rather than two, and a future change that raises the compare ceiling would
   spend it.

## 12 · What looking at it changed

The first report back was three complaints, all from reading the shipped screens. Every one was
right, and two of them were mistakes rather than trade-offs.

### The legend was below the fold

`RouteBreakdown` says in its own comment that the table is the strip's legend, and §7 above
argued the table belongs under the climb list because a climb changes the ride more than a
surface does. Both cannot be true. Four coloured bands you have to scroll to decode are a
puzzle, and the first thing anyone does with a puzzle is stop looking at it.

The two arguments were never equal. Climb ordering is a preference about what to read first;
legend adjacency is what makes the strip mean anything at all. The table moved up.

The strip also went from 10 px to 16. A segment's width is its share of the route, so 281 m of
cycle path on a 7.7 km route is 13 px of a 356 px strip — a 13 × 10 chip is not enough colour to
judge a hue against three others.

### The palette was fixed at the wrong thing

The four cells were pinned at L\* 45.5 to 45.9, borrowing "read by hue at held lightness" from
`gradeScale.ts` — correct there, because a gradient scale is a *severity ramp*. Road class is
four categories, and the worst pair was ΔE 27.4: `path` against `road`, two near-neutrals.

The obvious fix was to let lightness vary, and that was said out loud before it was checked. A
sweep says it buys **at most 1.6 ΔE**: the best fixed-lightness set scores 38.48 against 38.55
free. Lightness was never the constraint, because the contrast window is only about 2:1 wide.

**Chroma was.** `path` goes from C 20.4 to 56.6 and `cyclepath` from a teal at h 170 to a green
at h 145, the teal having sat right next to the blue-grey `road`. Worst pair is now **ΔE 38.2**.
`main` is untouched: crimson at h 15 is the only red in the window, a true orange-red peaks at
ΔE 12.7 against the bands and fails, and its 13.1 is the most a red can manage.

`chrome.test.ts`'s mutual floor goes 18 → 30. A floor well under the measured worst is one that
lets the whole gain be given back an edit at a time without ever failing.

### The map and the table were speaking two languages

The strip is colour; the map is texture, because the map cannot have four more hues. Two
languages for one fact is a seam, and the report was exactly that: the line and the table do not
look like they are about the same thing.

The fix is in the table, not on the map. Rows that produce a mark carry a **drawing of it** in
the route's own colour — same dash spacing, same flanking pair. Seeing samples on only a few
rows of eight is itself the explanation of why the line is quiet everywhere else, which is the
half of the design that was not communicating at all.

The first idea was a map highlight driven by dragging the strip, and it was measured out: the
open sheet leaves about 110 px of map, so the stretch being pointed at is usually hidden behind
the sheet doing the pointing.

### The turn arrow was 20 px

Folded away, the callout line *is* the navigation. The rest of the panel is figures to be read
and this is the one thing on it to be **recognised**, which is a cheaper act and needs size. It
goes to 2rem on the strip, and the opened panel gains a page where it is 4.5rem.

A page rather than an automatic promotion, and the reason is a rule the panel already holds.
The instinct was to let the panel promote the turn when one got close; `hudDrag.ts` says a tap
anywhere but the chevron deliberately does nothing, because that surface is where a hand lands
and resizing the figures being read is hostile. A takeover on a timer is the same hostility.

`hudAxis` waits for the first dozen pixels and writes nothing until one axis is clearly ahead —
`sheetDrag`'s `pendingVerdict` shape. A diagonal tie goes to resizing, the gesture the panel had
first. **The graph keeps its turn line**: taking it away would mean anyone who stays on the
graph loses the turn entirely, which is a worse panel than the one before there were pages.

Three things `drive-surface.mjs` caught that no test could:

- A sideways drag across text is a text selection. The first swipe came back with "20 m"
  highlighted in blue.
- The page sliding off to the left stopped **11 px inside the panel** and showed a sliver of
  chart down the edge. The panel clips at its border box and the layer inside carries 0.7rem of
  padding, so the clip needed its own window. A probe showed the track had been translating a
  full page width all along, which is not what it looked like.
- The navigation page sat at the top of a layer sized to the taller graph, leaving a hole under
  it.

And one that was the *driver's* fault and worth recording: the page persists across launches, so
with `--keep` a second run opened on whatever page the first run swiped to and the shot named
for the graph quietly showed navigation.

### The review caught the one that would have shipped

An adversarial review of those four commits found a bug the driver had walked straight past,
because the driver swiped from the middle of the panel and a rider would not.

`.hud-collapse` spans the whole bottom edge, and the page dots are painted **inside it**. So the
one thing on screen saying "there is another page" is also the toggle — and the tap test asked
`wasTap(drag.travelled)`, the *vertical* travel alone. A clean sideways swipe barely moves down,
so it read as a press: the page never changed and the chevron's click folded the panel. With a
few pixels of thumb wobble it did both.

The test measures both axes now, and a gesture from the chevron that turned out to be a drag
suppresses the click it leaves behind — which also fixes a bug that predates the pages, where a
vertical drag from the chevron settling back where it started folded the panel on the click.

Three more from the same review:

- **`--hud-x` had an exit that never restored it.** The chevron-tap branch wrote `--hud-p` home
  and left the track parked at whatever fraction the finger reached, with the dots and
  `aria-hidden` both claiming a single page.
- **The navigation page said "No turns ahead on this route" off route and before the first
  fix.** A claim about the road made out of a missing position, which is the error the flat-chart
  rule already names. The map and the callout can go quiet there because something else on
  screen is explaining; a page the rider swiped to cannot.
- **The gesture measured the panel's border box** while the track moves by the page's content
  box — 366 against 341.6 at 390 px, so the page lagged the finger by up to 24 px.

The driver now swipes from the dots specifically, and reports both facts: the page changed, and
the panel is still open.

### Then it was ridden on a phone, which took three more things off the panel

- **The chevron.** It read as a control on a surface whose whole gesture is a drag — a button
  saying "press me" in the middle of something you pull. Off the screen, and still in the DOM,
  because a keyboard, VoiceOver and any synthetic press all reach the toggle as a click and
  none of them can drag. The page dots take the middle of the bottom edge, which is also where
  they stop sitting inside somebody else's hit area.
- **The graph page's turn line.** §12 argued for keeping it. Riding said otherwise: the graph
  page is the terrain, and a miniature turn on it competes with the page that does the job
  properly. Folded, `calloutFor` still gives the strip the turn over the climb, and folded is
  where most of a ride is spent.
- **The navigation page's left alignment.** Centred across the panel now as well as down it.

And the drivers mute the app before they ride it, because headless Chrome has a voice and a run
was announcing every junction into the room.

### And then the arrow, which was never centred in its own box

Riding it again produced one more: the words beside the turn read as floating above it, on the
callout line and worse on the navigation page.

Nothing in the layout was wrong. Both places are a flex row with `align-items: center`, and
both centred the glyph's **box** against the words exactly. The arrow inside that box was the
part that was off: the family is anchored at the stem's base, so every figure runs from y=21
up to wherever its head lands, and the *ink* therefore sits low by a different amount for each
kind — 1 unit of 24 for a straight-on arrow, 3.34 for a right turn, and 4.5 for a sharp one,
whose head folds back down beside its own stem. A fifth of the glyph, which is 6 px on the
callout line and 13 on the navigation page.

So each shape now declares the vertical extent of what it actually draws and the drawing is
translated to put the middle of that extent on the middle of the box. Per kind rather than one
constant for the family, because the error spans 1 to 4.5 and a single shift would leave both
ends of the set wrong in opposite directions. The cost is that the stem's base moves slightly
as the turn changes, which nothing on the panel shares an edge with — where sitting a sixth of
a glyph away from the words it belongs to is visible every time.

`TurnGlyph.test.ts` renders every kind and measures the ink out of the markup rather than
trusting the declared spans, which is the one thing the arrangement is fragile about.

## 13 · Not done

- **Street names at turns**, per §9.
- **A cycle network overlay across the whole map**, with route numbers. Still needs a planetiler
  pipeline and a second archive per region. §1 changes the picture only for the *route*, not for
  the map: a road the rider is not on still cannot be shown as part of the NCN.
- **Smoothness.** In the vocabulary and parsed, but not shown. In British data the largest row
  would be Unknown, and a table whose biggest row is Unknown teaches riders to skip it.
- **Lifting the basemap's cycleway styling** off the path chroma ceiling. Worth doing, and worth
  doing after a ride shows whether the route bands settled the complaint on their own.
- **A setting for spoken turns.** The existing mute toggle covers all speech. Whether a rider
  wants climbs but not turns is a real question and one for the road.
