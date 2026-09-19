# Phase 15 — stops along the way

Implemented 2026-09-18. A plan could always hold more than two points, and the engine was always
told about all of them: `run()` has joined every waypoint with `|` since phase 1, and BRouter
routes via points natively. What was missing was everything around that.

- **Nothing re-routed.** `addWaypoint` asked for a run only on the one-to-two transition, so a
  third pin appeared on the map and the two-point line under it did not move.
- **A tap always appended.** A point tapped beside the line became the new *finish*. The plan
  card's own note admitted it: *"add more stops after your finish."*
- **The card showed two points.** `PointsCard` read `[start, ...rest]` and drew the first and
  the last, so the middle of a plan was invisible unless the sheet was opened.
- **A chosen route made the map inert.** `mapTapAction` put "revert the choice" ahead of "place
  a point", so with a route chosen the first tap un-chose it and only the second placed
  anything — see §5, which is the one pre-existing rule this phase had to change.

And `PlanSlot` has carried a `'stop'` member since the search screen was written, with a
*"Where do you want to stop?"* placeholder behind it and no gesture anywhere that set it.

---

## 1 · Where a tapped point lands

`insertionIndex` in `plan.ts`, pure and tested. For each leg `a → b` it costs the detour the
point would add — `d(a,p) + d(p,b) − d(a,b)` — and compares that against `d(finish,p)`, which is
what extending past the finish would cost. Cheapest wins.

So one formula produces both behaviours a rider expects and neither has to be learned: a tap
beside the line bends it, a tap past the finish lengthens it. There is no via mode to arm and no
Add-a-stop button on the map, which keeps the app's oldest rule intact — a tap places a
waypoint — and avoids reintroducing the mode the pin toggle was removed for.

**Measured over the waypoints, not the drawn route.** Nearest-point-on-the-line is the obvious
alternative and is worse twice: it has no answer at all when the route is stale, failed or not
yet computed, and for a tap well off the line — swing out to the coast — the nearest point on
the line says nothing about how far out of the way it is.

Two deliberate exclusions, both in the tests:

- **Prepending is not a candidate.** A tap behind the start becoming a *new start* is
  surprising, and the search's start slot and dragging the start pin both already do it
  properly. It becomes the first stop instead, visible in the card and one × from gone.
- **Ties go to the earlier leg.** This only arises on a closed loop, where the outbound and
  return legs are coincident, the costs are identical, and the rider's intent is genuinely
  ambiguous too. Deterministic beats arbitrary — the alternative is the same tap landing
  differently on two runs.

## 2 · You cannot shape a comparison

Three cards are three answers to *which way between these two ends*. A stop changes the
question, so all three are void — and re-running them on every tap would put three blocking
Wasm searches between the rider and the line they are drawing.

`profilesToRun` gained a `pointCount`, defaulting to two: above it, one profile runs and nothing
is deferred. Deferring would be wrong rather than merely slow — a deferred card is an *offer to
compute*, and there is nothing left to compute it against.

The profile is `isRoutableProfile(chosen) ? chosen : preferred`, which is the fallback
`rerouteProfile` already uses and for the same reason: `chosen` can name the `recorded`
pseudo-profile, which routes nothing. If the rider was still comparing when they tapped, their
own style wins and the sheet's heading changes from *Choose a route* to *Your route*.

`plan.selection` is left alone throughout. It is what the rider is *offered*, not what is on the
map, so taking the stops back out restores the three-way comparison rather than leaving them
with whichever style they happened to shape in. The sheet filters on what is routed while
shaping and on the selection otherwise.

## 3 · Every edit routes, and the line goes stale rather than blank

A tap, a pin drag and a removal all ask for a run now. A drag fires on `dragend` only, so that
is one search per drag and no debounce is needed anywhere. Falling below two points clears the
line instead, which is what removing a finish has to do.

`run()` clears the route source before a fresh comparison and **does not** while shaping. The
old line stays, drawn in a new `stale` `RouteState` at 0.3 opacity with its casing down to 0.2.
A blank map for the second or two the Worker blocks inside Wasm reads as the app having dropped
the tap; a dim line reads as the app thinking. `stale` beats every other state including an open
comparison — a shaping run is about to replace all three lines with one, so leaving two at
candidate weight would claim they were still on offer. Never dimmed while riding: on the bike
that line is still the road being followed, and a reroute is when it is looked at hardest.

A shaping run **replaces** the route set rather than merging into it, and commits nothing when
it fails — the old line comes back at full strength under the error, which is the same
worst-possible-response guard `rerouteFrom` already had.

Rapid taps queue rather than cancel. `runSeq` already voids a superseded result, and cancelling
means terminating the Worker and re-opening every OPFS handle. At three to five deliberate taps
that is the right trade; it is a thing to watch on a ride.

## 4 · The camera stopped following the plan

The ride screen framed the route whenever the profile set *or the waypoint count* changed. Under
shaping that is a re-fit per tap: the rider zooms in, taps, is pulled back out to the overview,
and zooms in again — the ground moving out from under the next tap.

The signature is now the profile ids plus `plan.framing`, a counter bumped only when the line
becomes a different journey without being cleared first. Every other path that replaces the
route — a new run, Reverse, a new end from the search, Make a loop — blanks it and frames itself
on arrival. Loading out of Saved does not, which is what the counter is for.

## 5 · Clearing a choice is a tap on a *line*

It used to be a tap anywhere. With a choice made, the first tap on the map reverted it and only
the second placed a point.

That was defensible while a third point did nothing, and the comment in `mapTapAction` said why:
the pin toggle was on by default, so the other order would have left the map gesture unreachable.
**Both halves of that have since gone.** The toggle was removed in phase 11, and a third point is
now a stop the route runs through — so under the old order a rider who had chosen a route could
not place one at all. Their first tap silently un-chose it, and the second then shaped in a style
they had not picked. This was found by driving the app, not by a test: the unit tests all passed,
asserting the old rule.

A clear is now what it always logically was — a tap on the line you already chose, meaning *not
this one*. A tap on a different line still chooses it, and a tap on the map is free to be the
gesture the whole app is built on. A lone route re-chooses rather than reverting, so a rider
shaping a single route can tap their own line without losing it.

## 6 · Closing a loop

The one shape a tap cannot make, because nobody can tap exactly on their own front door — so it
is the only part of this that needed a button. It sits in `.sheet-actions` with Reverse and
Clear, the two other things that act on the whole plan rather than on a point, and it is
disabled once the ends are within 50 m of each other (`isLoop`, generous so that a finish dragged
back onto the start counts).

What it appends is an out-and-back, which is the honest starting shape rather than a
disappointing one: BRouter is asked to go there and come back and is free to return a different
way. The circular ride comes from the two taps after it, which is the flow the feature exists
for. The line is cleared rather than left to go stale — a loop is roughly twice the journey it
was, not the same route about to be refined — and that also frames it.

`Clear route` lost its second word to fit three buttons across 390 px. The labels may not wrap:
the sheet interpolates between two *measured* heights, so a row that is two lines tall on one
phone and one on another retargets an animation halfway through.

## 7 · A stop with a name

The search screen's field list gained one row between the start and the finish: `+ Add a stop`,
or `2 stops · add another` once there are some. It sets `slot = 'stop'`, and everything
downstream was already written — `withEndpoint` inserts before the finish, `placeAt` routes.

This is the only way to give a stop a name. A stop tapped onto the map is a position and shows
its coordinates, because there is no geocoder; one picked off this list was handed to the rider
by the app, which is the other direction and costs nothing.

It is quieter than the two fields — no card, no ring, a hollow badge — because it is an action
rather than a value, and a third row in the same clothes would claim the plan has a stop it does
not. It counts the stops already placed rather than listing them: the pins and the plan card are
both already that list.

`placeAt` keeps the drawn line for the `'stop'` slot and only for that slot. A stop leaves both
ends where they were, so the old line is still the right shape and can go stale; replacing an
end makes it not stale but *wrong*, and a wrong line is worse than none.

## 8 · One point list, drawn twice

`waypointRows` in `plan.ts` names and numbers every point — `S`, `1`, `2`, `F`, and `Rejoined`
for a point the app added after a wrong turn, which is not counted so that it cannot renumber the
pins the rider placed. Three surfaces derived that independently before: the map markers, the
plan card and the sheet's list.

`PointList` is the row markup, used by the card and by the open sheet. The sheet used to draw its
own — a `Start | coordinates | Remove` table under a 4.5 rem label column — so one list had two
vocabularies, and the heavier of them was on the surface a rider shaping a route looks at most.
Its CSS is gone.

The list moved out of the route detail and into the sheet's default view, where the actions that
act on the journey already are. It describes the plan, not the route that was computed for it.

The card's note is the whole discovery mechanism for stops, so it had to be right. It is two
sentences, because the card is on screen for a *moment* — the second point routes the plan and
the routed card replaces it — so the version a rider actually reads is nearly always the one with
a start and no finish, which is exactly the state in which "along the way" is not yet true.

## Verified

- **743 tests**, 740 passing and 3 skipped, up from 721. New: `insertionIndex` (7 cases including
  the no-prepend rule and the loop tie), `waypointRows`, `isLoop`, `profilesToRun` above two
  points, the `stale` route state, and the rewritten `mapTapAction` precedence.
- **Driven end to end in headless Chrome at 390 × 844, in both themes, against a real Edinburgh
  basemap and a real `W5_N55.rd5`** — so every route below is an actual BRouter run.
  `tools/drive-stops.mjs` is that run, and it exists rather than being folded into `drive.mjs`
  because shaping is the one flow that cannot be faked from a seeded plan.
  - Two taps → three routes compared. Choose *Relaxed*.
  - A third tap beside the line → three points, **one** route, `chosen` still `trekking`, 5.2 km
    becomes 5.7 km through the stop.
  - The sheet reads *Your route*, one card, `S / 1 / F`.
  - Make a loop → four points, 10.9 km, the button disabled afterwards.
  - The search shows `2 stops · add another`; the stop field opens with its own placeholder.
  - Removing the stop → back to two points and back to the three-way comparison.
- **The walkthrough's pictures regenerated** (`npm run shots`), because `compare.webp` showed a
  sheet with two action buttons and no point list. Its crop is now measured off the sheet rather
  than being the constant `y: 244`, which had started slicing the heading in half.

## Not done, and what a desk cannot answer

- **Not ridden.** Phases 7 through 15 are all unridden; this adds a gesture made while *sitting
  still*, so it is less urgent than the HUD drag, but the new tap precedence changes the ride
  screen's central gesture and only a real thumb settles it.
- **How often a tap meant for the map lands on a route line.** `routeAt` has a tolerance, and
  shaping means tapping *near* the line by definition. On a desk with a mouse this never
  happened once; a thumb is not a mouse. If it is a problem, the fix is a tighter tolerance while
  a route is already chosen, not a return to modes.
- **Whether a queued search feels slow.** Three taps in quick succession means three sequential
  Wasm searches, the first two of which are thrown away. Cancelling costs a Worker respawn and
  every OPFS handle with it; the trade was chosen without measuring the respawn.
- **Dragging a stop.** `moveWaypoint` re-routes on release now, which is the whole of it — but
  dragging a pin on a phone while the line redraws under it has not been tried.
- **Loops longer than an out-and-back.** BRouter is free to return a different way and sometimes
  does; how often, and whether a rider has to place stops to get a genuine circuit, is a road
  question.
