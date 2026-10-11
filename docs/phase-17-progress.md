# Phase 17: the battery, and a map that would not keep still

Done 2026-10-11, on branch `ride-battery`.

A real ride drained the phone by about 1% a minute with the screen on. That is roughly 60% an
hour, or 8–10 W, which is what a phone draws with its GPU flat out. Reading the code pointed at
the map redrawing almost all the time while riding. This phase measured that first, then fixed
it in three steps, and a fourth bug turned up during the measuring.

**Nothing here has been measured on a phone.** Every figure below comes from headless Chrome on
a Mac. They count how often the map drew a frame, not how much power that took. Whether the drain
actually fell has to be checked with a real ride on a real iPhone added to the Home Screen.

---

## 1 · The counters

`web/src/ride/workload.ts` is a module singleton of per-second ring counters, built the same way
as `downloadStore`. It counts:

| counter | where it is counted |
|---|---|
| map frames drawn | MapLibre's `render` event, `useMapLibre.ts` |
| compass events received | the `deviceorientation` listener, `useHeading.ts` |
| compass heading updates | each time the smoothed compass reading reaches React state |
| GPS fixes | `useGeolocation.receive` |
| riding screen renders | an effect in `RideView` with no dependency list, counted only while riding |
| camera moves | each `easeTo` the follow camera issues |

Each count is an array index and an add. Nothing publishes on a count. Diagnostics polls the
counters once a second, for the same reason it polls `sourceStats`. Diagnostics shows the rate
over the last 60 seconds and the last ride's figures. **Send report** posts them to the spike
server, which writes them into `docs/spike-runs/`. The riding screen has no way into Setup, so
mid-ride the same numbers can be read from `window.freeWheelWorkload`, using Safari's Web
Inspector on a phone tethered to the Mac.

`web/tools/drive-ride-load.mjs` is how the numbers below were made. It imports
`data/basemap/london.pmtiles` through the gate's manual import and seeds `london-brighton.gpx` as
the plan, then starts a ride. It fakes the GPS by walking a fix down the route at 5.5 m/s, once a
second, with course and speed set. It fakes the compass with `deviceorientation` events every
16 ms: the route bearing, plus a ±4° weave at 0.5 Hz, plus 6° of noise per sample. Then it runs
five one-minute scenarios and reads the counters, and CDP's `Performance.getMetrics` gives the
main thread's busy time.

### What the driver cannot tell you

- The compass is a model I chose to look plausible. Nobody recorded it off a real handlebar.
- `requestAnimationFrame` is replaced with a 16 ms timer, because a headless tab never fires a
  real one. A ProMotion iPhone draws up to 120 frames a second, so on a phone any stretch of
  animation costs up to twice the frames it costs here.
- Rendering runs on SwiftShader, at a pixel ratio of 1. Before the fix, the main thread was 67%
  busy (40 s per minute), so the baseline frame counts are capped by the CPU. They show the most
  the CPU could draw, not how often the map asked to redraw. The real demand was higher.
- In Chrome the compass needs the same permission tap as on iOS. So with course-up off it sends no
  events, which is why `orientation` is 0 in the first three rows. That matches the app on a
  phone: a rider who never turns on course-up never grants the compass. So the compass jitter on
  the reported ride only applies if course-up was on, or had been on earlier in that session.

## 2 · Before

Commit `5544aa1`, which adds the counters and changes nothing else. Figures are per minute.

| scenario | frames | compass events | heading updates | fixes | renders | camera moves | main thread s/min |
|---|---|---|---|---|---|---|---|
| north-up, standing still, no compass | 1260 | 0 | 0 | 60 | 120 | 60 | 40.5 |
| north-up, GPS only | 1244 | 0 | 0 | 58 | 115 | 57 | 40.7 |
| north-up, GPS + jittery compass | 1258 | 0 | 0 | 58 | 116 | 58 | 40.3 |
| course-up, GPS + jittery compass | 1247 | 1347 | 52 | 54 | 155 | 101 | 40.7 |
| course-up, stopped at lights, jittery compass | 1220 | 1298 | 70 | 52 | 170 | 118 | 41.3 |

In every scenario the map was drawing frames non-stop, standing still included. The camera eased
for 700 ms to the same point on every fix. The compass added roughly one more camera move per
heading update. The main thread was so saturated that only about a third of the 60 Hz compass
events got through.

## 3 · What was wrong, and the fix

**The camera** (`15b2983`). The camera effect depended on `fix` *and* `heading.heading`. Every time
either changed it called `easeTo({center, bearing, duration: 700})`, and it did so with course-up
off too, where the heading has nothing to rotate. The decisions now live in `src/ride/camera.ts`,
which is pure and tested:

- The camera follows lazily. It only recentres once the rider's dot leaves a box covering ±15% of
  the screen around its centre.
- With course-up on, the map only turns once the heading is 12° off.
- The heading is read through a ref, so a compass change cannot schedule a camera move. The camera
  moves at most once per fix.
- Above 2.5 m/s the GPS course is used instead of the compass. The compass covers the cases where
  iOS reports no course: junctions, lights, wheeling the bike.
- The arrow only redraws on a change of 8° or more, at most twice a second. That decision is made
  against a ref, so it does not happen inside a state updater sixty times a second.
- Recentring and rotating are still one `easeTo`.

**The symbol fade** (`f3f3645`). Once the camera stopped, frames were still around 1,100 a minute
while riding in a straight line, against 60 standing still. The rider's arrow is a symbol layer.
Every fix's `setData` re-runs symbol placement, and MapLibre then fades the result in over its
300 ms `fadeDuration`, with frames running the whole time. The fade can only be set when the map is
built, so while riding the code writes the private `_fadeDuration` field the render loop reads. If
a future MapLibre renames that field, the guard skips the write and the fade comes back; nothing
throws.

**Cost per frame**, in the same commit. While riding:

- The map is capped at a pixel ratio of 2. An iPhone is 3, so this draws 2.25× fewer pixels.
- The HUD, the map buttons and the map credit lose their backdrop blur and use `--panel-solid`.
- The live dot pulses three times and then stays still.

Planning keeps all three. The headless driver runs at a pixel ratio of 1 and its frame counts
ignore the blur, so none of the per-frame savings show up in the tables. That is arithmetic and
WebKit's known costs, not something measured here.

**Start's zoom never finished** (`25523fc`). Found while looking at the baseline screenshots: the
ride ran the whole way at z8.5, the zoom the plan had been framed at. `easeTo` stops any animation
already in flight and keeps whatever zoom it had reached, so the first fix's recentre cut Start's
900 ms zoom short. On a phone the fix usually lands near the end of that zoom, so the effect is
milder there than here. `cameraStep` now does nothing while the map is already moving, unless
forced.

## 4 · After

| scenario | frames | compass events | heading updates | fixes | renders | camera moves | main thread s/min |
|---|---|---|---|---|---|---|---|
| north-up, standing still, no compass | 60 | 0 | 0 | 60 | 120 | 0 | 0.6 |
| north-up, GPS only | 321 | 0 | 0 | 60 | 120 | 5 | 0.9 |
| north-up, GPS + jittery compass | 445 | 0 | 0 | 60 | 120 | 8 | 1.2 |
| course-up, GPS + jittery compass | 347 | 3750 | 5 | 60 | 125 | 6 | 1.2 |
| course-up, stopped at lights, jittery compass | 120 | 3750 | 0 | 60 | 120 | 0 | 0.9 |

The middle steps, from the same driver:

- **Camera fix only, at z8.5.** Frames were about 1,140 a minute while moving and 60 standing
  still, with 0–1 camera moves.
- **Camera fix and symbol fade off, still at z8.5.** Frames were about 120 a minute, with 0–1
  camera moves.

The final run is the only one ridden at street zoom. That is why it shows 5–8 recentres a minute,
which is what the follow box is for at 20 km/h. The GPS-only and GPS + compass rows differ only in
a setting the app ignores while course-up is off, so 321 against 445 is how much the runs vary.

Summing up. Standing still, frames dropped from about 1,260 a minute to 60, one per fix. Riding
at street zoom, they dropped to about 320–450, mostly the recentres plus one or two frames per
fix. Main-thread time fell from 40 s a minute to about 1. With course-up on, about 3,750 compass
events a minute now reach the page and only about 5 become heading updates; no camera move comes
from the compass at all.

## 5 · Still open

- **Measure it on a phone.** Do a real ride with the Diagnostics report sent at the end, and read
  the battery drain over the same distance before and after. That is the only number the rider
  cares about.
- The live dot no longer pulses after the first seven seconds. The elapsed time ticking beside it
  is now what says "live". That is a design call, and it can be reverted on its own.
- With course-up on and the rider standing still, the map only turns on the next fix. If iOS sends
  fixes slowly to a stationary phone, turning the bike at the lights will take a moment to show.
