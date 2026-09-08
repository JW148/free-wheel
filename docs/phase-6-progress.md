# Phase 6 — the ride knows where you are

Written 2026-09-08.

Phases 1–5 built an app that plans a route and draws a dot on it. This phase makes the app
*navigate*: it knows where the rider is **on the route**, what is coming, how hard they are
working, and whether they have come off it — and it remembers what happened afterwards.

Six features were asked for. All six landed, plus four that fell out of the same machinery
cheaply enough to be silly to leave out.

| asked for | status |
|---|---|
| Save and manage routes | ✅ IndexedDB library, routes and finished rides in one list |
| Route progress while riding | ✅ snapped to the polyline, with distance left and an arrival clock |
| Rerouting while riding | ✅ automatic (rate-limited) and manual |
| Progress on the elevation graph | ✅ a magnified 3 km lookahead, plus a whole-route bar |
| Map oriented to the device heading | ✅ compass where iOS grants it, GPS course otherwise |
| Power output | ✅ the standard cycling power equation, from speed and the route's gradient |
| *(added)* Ride recording and summary | ✅ with a GPX of what was actually ridden |
| *(added)* Climb list when planning | ✅ same detection the HUD calls out on the road |
| *(added)* Reverse the route | ✅ re-routed, because the way back is a different road |
| *(added)* Storage persistence request | ✅ in Setup → Rider |

## The shape of it

Everything interesting is **pure and tested**, and the React layer only sequences it. Five
modules, 229 assertions, no DOM:

```
progress.ts    snap a fix to the route; distance along, remaining, gradient, ETA, off-route
climbs.ts      the climbs and descents on a route, as named features
power.ts       watts, from speed and gradient
rider.ts       mass, drag area, rolling resistance — and what a rider actually knows
recording.ts   what happened, accumulated one fix at a time
library.ts     saved routes and rides (IndexedDB)
```

`useRideTelemetry` is the only place they meet, and it is one effect rather than four,
because they share an answer: power needs the gradient, which needs the snap; the record needs
the height, which needs the snap; the ETA needs both the snap and the record. Four effects
keyed on the same fix would recompute the snap four times and see each other's state one
render late — so the ETA would describe the *previous* fix.

## Three things that were wrong first, and how

### 1. Climb detection: a plain threshold finds nothing or everything

The first version resampled the elevation to a 25 m grid, smoothed it, split it into monotonic
runs, and pruned runs smaller than 8 m by persistence — absorbing the smallest run into its
neighbours until nothing small was left. That part was right and still is: on London → Brighton
it takes 259 raw runs down to 34 real ones.

What was wrong was what came next. Each surviving run was reported as one feature. On that
route the merge produced a run rising **115 m over 9.8 km** — 1.2% overall, below the 1.5%
threshold, so *nothing was reported at all* for that stretch. Buried inside it was a **62 m
ramp at 6% between 27 and 28 km**, which is the single thing a rider on that road wants to
know about. Seventeen kilometres of the route had no features listed and the ride's hardest
kilometre was one of them.

The fix is to extract the best-scoring stretch *inside* each run and then recurse either side
of it. The score is `gain² / length`, and it was chosen for one property above all others:

> For a constant gradient it must prefer the **whole** climb.

`gain²/length` reduces to `grade² × length` at constant gradient, which grows with length — so
a steady 4% climb is reported once rather than chopped into pieces. Two obvious alternatives
fail that test outright: plain gain always takes the whole run including its flat approach, and
plain gradient always takes the two steepest adjacent samples.

It splits only when the difference is dramatic. Worked through:

| case | whole | sub-stretch | winner |
|---|---|---|---|
| 1 km at 2% + 300 m at 12% | 2.41 | **4.32** | the wall, correctly |
| 1 km at 5% + 300 m at 7% | **3.88** | 1.47 | the whole climb, correctly |
| 9.8 km at 1.2% with a 1 km 6% ramp | 2.03 | **3.84** | the ramp, correctly |

Result on London → Brighton: **22 features in 5 ms**, against 20 before — but including the
27 km ramp, which is the point. Both failure modes of an unsmoothed threshold — zero features
or hundreds — are asserted against in `climbs.test.ts`, along with a dead-flat towpath carrying
±1.5 m of SRTM noise, which must produce nothing.

There is a cost, and it is stated in the tests: smoothing rounds the shoulders of a climb, so a
true 6% over 1 km reads as **5.3%**. That is the price of not reporting a canal towpath as two
hundred climbs, and it is under 15%.

### 2. Snapping needs a hint, or an out-and-back lies to you

Distance along the route is computed by projecting the fix onto the polyline. Done globally —
nearest point over the whole route — it is O(route) per fix *and wrong on any route that
crosses itself*. An out-and-back on the same road is two coincident lines, and the nearest-point
search picks between them by floating-point luck. A rider on the way home would see the
distance remaining jump back to the full route length.

So the previous answer is passed in as a hint and a window is searched first
(−120 m to +600 m). Backwards is tight on purpose: you can stop and roll back a few metres, but
a match 500 m behind is a mis-snap, not a rider reversing. If the windowed match is worse than
45 m the whole route is scanned, which is what recovers the position after a tunnel, a long
signal loss, or a route loaded with the rider already halfway along it. A tie goes to the
window, because a progress bar that lags is better than one that jumps.

### 3. Power must come from the route's gradient, never the phone's altitude

GPS altitude is the worst channel a phone has — tens of metres of error, drifting while
stationary. Differentiating it produces gradients that swing through ±20% standing still, and
because power goes as `m·g·sin(θ)·v`, that is ±600 W of pure invention.

The route's own `<ele>` values came from SRTM through BRouter, are smoothed over a ±60 m window,
and do not move when the rider does. The cost is that power is only meaningful while on the
route — which is exactly when it is shown, and it is cleared the moment a reroute replaces the
geometry.

The estimate's accuracy is deliberately **asymmetric**, and that asymmetry is the feature.
CdA is the only genuinely uncertain input, uncertain by perhaps ±15%. Measured against the
model itself:

| | CdA 0.32 → 0.65 |
|---|---|
| 12 km/h up 8% | **+3%** |
| 32 km/h on the flat | **+64%** |

Climbing is when a rider wants to know whether they are going too hard, and climbing is where
gravity is 90% of the resistance and the aero guess barely matters. `RiderPanel` shows what the
current setup predicts for 25 km/h flat and 10 km/h up 8%, because "CdA 0.40" is unfalsifiable
and "215 W up an 8%" can be checked against what a rider knows they hold.

Two smaller details that are easy to get wrong: the drag term is **signed**, so a tailwind
stronger than the rider pushes rather than resists (squaring without the sign reports someone
being blown along as working hard); and freewheeling downhill returns **0 W**, not a negative
number, because a rider understands 0 W instantly and −180 W not at all.

## Colour: the two ride overlays are achromatic, on purpose

`docs/phase-4-progress.md` establishes that every route colour must sit **ΔE ≥ 16** from every
basemap colour, and six categorical hues at C ≥ 45 already use up the usable circle. The two
new map overlays — the stretch already ridden, and the climb coming up — would each have needed
a seventh and eighth hue threading the same needle, and a rider glancing down would then have
to decide whether an orange stretch of line meant "this is the trekking route" or "this is the
climb".

So neither carries an identity:

- **Travelled** is a neutral grey painted over the route. What is behind you has stopped being
  a route and become map furniture; it should look like it.
- **Focus** — the climb ahead — is a blurred halo *under* the casing, in whichever of black or
  white contrasts with the theme. A lightness effect, not a hue, which is why it needs no
  clearance rule and why it works over a route line of any colour.

The gradient scale on the elevation strip *is* chromatic, because it is drawn on a panel we
control rather than on terrain we do not. Its bands are the ones cyclists already think in — 3,
6, 9, 12% — rather than an even split of the range, which would put three of five bands above
12% where almost no British road goes. Descents get one band: a rider needs to know a break is
coming, not five gradations of how steep it is.

## Storage: why IndexedDB, when the app already has two stores

- **`localStorage`** holds the current plan and that is right: one small object, read
  synchronously at startup, and losing it costs one re-tap. It cannot hold a library. A 95 km
  route's GPX is 240 kB and WebKit's quota is ~5 MB *per origin, shared with everything else
  the app keeps there*. Twenty saved routes would evict the plan, the theme and the basemap
  choice along with themselves — and the failure would arrive as a silent `QuotaExceededError`
  inside `savePlan`'s catch block.
- **OPFS** is the wrong shape. It exists to serve `FileSystemSyncAccessHandle` reads from the
  engine Worker, and the whole registry is built on the rule that exactly one handle may be open
  per file. Routes want small keyed records, not byte ranges.
- **IndexedDB** is what is left and is also simply right: async, main-thread-safe, quota shared
  with OPFS at ~60% of the disk, durable in a home-screen PWA. The wrapper is ~60 lines because
  nothing here needs more than get, put, delete and getAll.

The summary figures are denormalised onto each entry on write. Parsing twenty GPX documents to
draw a list is work the phone can see, and the figures never change once saved.

## Reversing a route re-routes it

`waypoints.reverse()` and keep the line would be wrong. A cycle route is **not symmetric**:
one-way streets, no-entry turns and BRouter's own cost model all mean the way home is a
different road. Measured on the test route, Edinburgh centre → Straiton:

| | distance | moving | climbing |
|---|---|---|---|
| outbound | 9.2 km | 37 min | 140 m |
| reversed | 10.1 km | 32 min | 103 m |

Nearly a kilometre longer and a quarter less climbing. Reversing the drawn geometry would have
put a line on the map the rider cannot legally follow *and* reported the wrong figures for it.

## Verification

Unit tests: **229 assertions across 14 files**, all pure. The five new modules are covered
directly, including the three GPS failure modes the recorder exists to filter — a receiver
jittering 4 m/s at traffic lights for ten minutes (must add zero distance), a 3 km teleport out
of a tunnel (must not be credited, but must re-anchor so the *next* step is measured correctly),
and a twenty-minute app suspension (elapsed time counts it; moving time and energy must not).

End-to-end in a desktop browser, with the basemap and `W5_N55.rd5` injected into OPFS and
`navigator.geolocation` stubbed to walk the computed route:

- routing, the HUD, power, climb callouts, progress and the arrival clock — all live and
  correct (27.0 km/h reported for a 7.5 m/s stub; 165 W on the flat rising to 265 W on a climb);
- going 1.2 km off the line raised the alert and the automatic reroute produced a fresh 9.2 km
  route from the rider's position to the unchanged finish;
- ending the ride produced a summary with distance, moving time, ascent and energy, and saving
  it put one record in the `rides` object store;
- the map carried all seven layers in the right order, the `rider-arrow` image registered, the
  travelled and focus sources filled with 33 and 21 coordinates, and the position feature
  carried a `heading` property;
- course-up matched the map bearing to the heading exactly (117° / 117°).

**Still unverified, and it is the verification that counts**: a real iPhone, added to the Home
Screen, in airplane mode. Specifically the compass permission prompt (`requestPermission` only
resolves from a user gesture, and desktop Chrome never asks), the wake lock, and whether the
HUD is actually readable at 25 km/h — which is not a thing a desk can tell you.

### One trap worth writing down

**A hidden browser tab never fires `requestAnimationFrame`, and MapLibre's style loader awaits
one.** The consequence is that the map silently never loads: no `load` event, no `error` event,
`isStyleLoaded()` stays false, `getStyle()` returns undefined, and no sprite or glyph request is
ever made. `styleReady` therefore never flips, so the route layers are never added and the
waypoint markers are never created.

This wasted half an hour looking for a bug in the marker code that was not there. Two symptoms
distinguish it from a real failure: `performance.getEntriesByType('resource')` shows *zero*
sprite and glyph requests, and there is no error of any kind. Shim
`window.requestAnimationFrame` to a `setTimeout` before the map is built and everything works.

It is a close cousin of the dead-worker trap in `CLAUDE.md` — a map that never draws, with
nothing in the console — and it fails the same way for a different reason.
