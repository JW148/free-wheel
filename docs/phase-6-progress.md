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
| *(added)* Spoken climb cues | ✅ on-device speech, fourteen cues over a 95 km route |

## The shape of it

Everything interesting is **pure and tested**, and the React layer only sequences it. Seven
modules, 255 assertions, no DOM:

```
progress.ts    snap a fix to the route; distance along, remaining, gradient, ETA, off-route
climbs.ts      the climbs and descents on a route, as named features
power.ts       watts, from speed and gradient
rider.ts       mass, drag area, rolling resistance — and what a rider actually knows
recording.ts   what happened, accumulated one fix at a time
cues.ts        what to say out loud, and when
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

Result on London → Brighton: **29 features in 5 ms**, including the 27 km ramp, which is the
point. Both failure modes of an unsmoothed threshold — zero features
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

## Speech, and why it says so little

Every other feature on the riding screen needs a rider to look down, and looking down at
25 km/h is the one thing a cycling app can ask for that has a real cost. The information that
matters most — a wall in 400 m — is also the information you most want *before* you are on it.
iOS carries its voices on-device, so this works in airplane mode like everything else.

Chattiness is the failure mode: an app that talks constantly gets muted, and a muted app says
nothing at all. So the bar is that a cue must change what the rider does in the next minute.
Five kinds survive it — a climb coming up, the top of a *hard* climb, a long descent, off
route, and the finish. Deliberately absent: kilometre ticks, speed, power, and anything the
screen already shows continuously.

Walked over the London → Brighton fixture at 25 m steps — 3,800 positions — that yields
**fourteen cues in 95 km**, roughly one every 7 km:

```
 5.3 km  Climb in 700 metres. 55 metres at 2 percent, steepening to 4 percent.
10.8 km  Climb in 700 metres. 24 metres at 7 percent, steepening to 10 percent.
26.3 km  Climb in 700 metres. 62 metres at 6 percent.
31.5 km  Downhill in 700 metres, for 1.2 kilometres.
...
94.4 km  Finish in 500 metres.
94.8 km  You have arrived.
```

`cues.ts` is pure and the decision is tested by advancing a number, because "say this once,
when this becomes true" is exactly the logic that silently regresses into saying it every
second. `cues.test.ts` asserts the whole-ride sequence: more than five cues, fewer than forty,
none repeated, and the finish last.

Three things about `speechSynthesis` that had to be designed around, all of which fail
*silently*:

1. **The first utterance needs a user gesture** on iOS. `prime()` is called from the Start
   button and says "Ride started", which both unlocks speech for the session and makes the
   connection between the tap and the voice obvious — which is why the feature ships on by
   default rather than muted-and-undiscovered.
2. **Utterances queue.** Each cue cancels whatever is speaking, because cues are only issued
   when they are worth interrupting for.
3. **The voice list loads asynchronously**, so nothing here picks a voice; the default for the
   document language is correct and immune to it.

There was a fourth, and it was a real bug caught in the browser: `prime()` originally checked
`enabled`, which is `riding && voice` — and at the moment the Start handler runs, `riding` is
still false in the render that closure came from. The one utterance that has to get through
was silently swallowed, and with it every cue for the rest of the ride. The caller checks the
mute setting instead, because the caller can see it correctly.

A review pass found five more of the same shape, all in the seam between the pure rules and
the browser, and all fixed:

- **Un-muting mid-ride never spoke.** A rider who muted last session starts the next one with
  the voice off, so Start never primes — and iOS will not speak from an effect it has not
  first spoken from inside a gesture. The toggle is itself a tap, so it now says "Voice on",
  which doubles as the unlock.
- **The first cue could cancel the priming utterance.** `say()` cancels before every
  utterance, and a cue on the first fix would therefore cancel a gesture-initiated utterance
  *before it started speaking* — which is the moment that unlocks the session. There is now a
  two-second grace after priming during which cues queue instead of interrupting.
- **Muting forgot what had been said**, because the reset was keyed on `enabled` rather than
  on the ride, so un-muting replayed every cue whose condition was still true — including a
  climb you were halfway up, announced as though it were ahead.
- **"Off route" was keyed to the route.** With automatic rerouting switched off — a supported
  setting — the geometry never changes, so a second wrong turn was met with silence. It is
  keyed to the off-route *episode* now.
- **"Finish in 400 metres" could follow "You have arrived."** The finish branch had no lower
  bound, so any fix that skipped the 500–60 m window in one step, or any drift back out after
  arriving, counted down to a finish already announced. `arrived` and `finish` were also the
  only unversioned keys, so a reroute after arriving left the new route with neither.

The approach window also lost its lower bound. It was 250 m, on the reasoning that a rider
almost on a climb can see it — true, and not the case it caught. Cues are said once, so the
only rider it silenced was one who *started* inside the window. On the Edinburgh test route
the first climb is 200 m in and was never mentioned at all.

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

## What a second review pass found

Everything above was written before the branch was reviewed. The review found eight more
problems, and the pattern is worth recording: **not one was in the pure logic, and every one
was on a boundary between a rule and the thing it was applied to.** The tests covered what each
rule does; what they did not cover was the rule being applied at the wrong moment.

- **A climb could vanish because the winning span failed the threshold.** `bestSpan` picked the
  top-scoring stretch and `extract` then checked it against the thresholds — but `gain²/length`
  is not monotone in gradient, so the winner is often a span that fails while a real climb sits
  inside it. A 10 km drag at 1.2% with a 250 m ramp at 5.8% scores 1.44 for the whole and 0.84
  for the ramp: the whole won, failed the 1.5% floor, and *nothing at all* was reported. This
  is the same bug the extraction step was introduced to fix, one level down. The thresholds now
  live inside the search, so it can only ever return something worth reporting.
- **The snap hint stopped protecting anything above 45 m.** The global fallback is a *superset*
  of the window, so it can never be worse — meaning "take the window only if it is better" was
  a tie-break that essentially never fired. One 46 m fix on a pair of parallel legs 36 m apart
  moved `alongM` 280 m onto the wrong leg, and because the answer becomes the next hint, it
  stayed there. Two changes: the threshold is now 250 m (a bad windowed match is either *tens*
  of metres — off the line but near it — or *hundreds* — a stale hint; they separate cleanly by
  magnitude), and the projection is clamped to the window rather than whole segments being
  included or excluded, which is what let a 900 m return leg be matched 450 m past the window's
  edge.
- **"Climbing still to come" contradicted "climbing" by 60%.** `cumulativeAscentM` summed every
  positive step: 943 m on London → Brighton against BRouter's own filtered 592 m, displayed on
  the same screen. A 6 m deadband — SRTM's stated vertical accuracy, not a fitted constant —
  gives 589 m, and 0 m against BRouter's 1 m on the urban fixture.
- **The library reported saves that had been rolled back.** `run` resolved on
  `request.onsuccess`, which fires when the database *accepts* a request, not when the
  transaction commits — and a quota overrun fails at commit. Worse, a failed commit fires
  `abort` rather than `error`, so an abort with no prior request error left the promise
  unsettled forever and the save button spinning. It settles on the transaction now.
- **Average speed was assembled from two different definitions.** Distance was gated on
  accuracy and moving time on a reported speed, and `summarise` divides one by the other: a fix
  with no speed (iOS omits it below a few km/h) added distance but no time, and a vague fix
  added time but no distance. They share their gates now, and where no speed is reported the
  ground is used instead.
- **Ascent had no teleport guard**, though distance did. A fix that snaps to another pass of the
  route hands over tens of metres of height between two seconds; 2 m/s is four times the world
  hour record for vertical ascent, so anything beyond that moves the reference without being
  credited.
- **A transient failure disabled the library until reload**, because `open ??=` caches a
  rejected promise as happily as a resolved one.
- **The "windowed" scan iterated from index 0**, so the hinted path — the one taken on every
  fix — was O(route) rather than the O(window) its docstring claimed.

A third pass over the UI wiring found nine more, in the same place — the join between a rule
and the moment it runs:

- **The map rotated but never followed.** Recentring and rotating were two effects, both with
  `heading` in their dependencies, so both ran in the same commit. `easeTo` stops whatever is
  in flight and defaults its target centre to the *current* centre, so the rotation cancelled
  the recentre before its first frame. One effect, one `easeTo`, now.
- **`shortestTurn` was solving a problem MapLibre does not have.** It was written on the
  assumption that `easeTo` interpolates the bearing numerically; MapLibre 6's
  `_normalizeBearing` already picks the nearest equivalent of the target. Deleted, and the note
  about it in `CLAUDE.md` corrected — a wrong gotcha is worse than none.
- **Panning spun the map to north-up.** The bearing reset treated "following is paused" the
  same as "course-up is off", so looking ahead turned the map under your thumb and turned it
  back twelve seconds later.
- **A rejected engine call pinned the routing spinner.** `route()` reports a *routing* failure
  by returning, but the call can still reject — a worker that would not spawn. Uncaught, that
  skipped `setRouting(null)` and left Reroute reading "Routing…" for the rest of the ride with
  no way to clear it.
- **The compass never let go.** Deactivating cleared the smoothing accumulator but not the
  reading, so `compass ?? courseDeg` returned a stale bearing on the next Follow — and, once
  non-null, permanently vetoed the GPS-course fallback.
- **`heading.request()` ran inside a state updater**, which StrictMode double-invokes: the
  second `requestPermission()` rejects while the first prompt is open, and the catch marked the
  compass denied even when the rider allowed it. Exactly the bug already fixed once in
  `prime()`, in a second place.
- **The mass fields bypassed their own limits.** `migrateRider` clamps on load, so 500 kg
  skewed the power model for a session and then silently changed on the next launch. Clamping
  on every keystroke is worse — typing "5" towards "55" snaps to the 30 kg floor — so the field
  holds its own text and commits a clamped number on blur.
- **The climb list, the elevation chart and the ride telemetry each computed `gradients()` for
  the same route.** Five milliseconds three times over, synchronously, while the drawer opens.
  Both `routeGeometry` and `gradients` are now cached in a `WeakMap` on the object they derive
  from, so the three share one computation and none of them has to know about the others.
- **"Downhill in 0 m"** — the descent callout ignored `inIt`, which the climb callout beside it
  has always honoured.

Two smaller ones in the CSS the branch inherited: `.drawer-body button:disabled` is later and
more specific than `.primary:disabled`, so the disabled-primary fix reached only the sheet bar
and not the drawer — which is where the disabled primary actually lives.

## Verification

Unit tests: **264 assertions across 15 files**, all pure. The five new modules are covered
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
