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

Eighteen entries now: every case at mode 0 and at mode 9. Mode 0 stays because it is what any
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

## 12 · Not done

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
