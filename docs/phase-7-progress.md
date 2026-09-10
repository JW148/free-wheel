# Phase 7 — after the first real ride

Written 2026-09-08.

Phase 6 was ridden. Six things came back from the road, and this phase is those six things.
None of them is a new capability so much as a correction: the machinery was right, and what a
rider actually does with a phone on a handlebar was not fully anticipated.

| feedback | what landed |
|---|---|
| iOS "Undo Typing" fires constantly on rough ground | ✅ no text field on the riding screen at all; naming moved to the library |
| No way back to the ride summary after dismissing it | ✅ rides auto-save, and the library opens the same figures again |
| The library does not distinguish planned from ridden | ✅ an All / Planned / Ridden filter over one list |
| Want to follow a ride you recorded, and to record without a route | ✅ `parseTrackGpx` and a `recorded` pseudo-profile — the Record entry point was withdrawn on 2026-09-10, see §3 |
| The position arrow is too small and too low-contrast | ✅ 45 px riding arrow, two-tone ring, and a mode-dependent size |
| The graph card should minimise, smoothly | ✅ a two-layer HUD with a measured-height transition |

## 1. Shake-to-undo, and why the fix is a deletion

The alert in the screenshot is iOS's **shake-to-undo**, a system gesture, offered whenever
WebKit's undo stack for the page has typing in it. A web page cannot suppress the alert: there
is no event to cancel and no attribute to set. The only lever available is to have nothing
undoable in the document.

So the ride-finished sheet no longer has a name field. It writes the ride to the library
immediately under the generated `8 Sep · 1.9 km` name, reports that it has done so, and offers
**Export GPX** and **Throw it away**. Renaming happens in the library, where the rider has
stopped and a keyboard costs nothing.

That change was worth making on its own merits — see §2 — which is the only reason it is an
acceptable answer to a bug we cannot actually fix. Two things soften what is left:

- While riding, `beforeinput` with `inputType: 'historyUndo'` is refused. The alert can still
  appear if *some earlier* edit is on the stack from the same page load; refusing the undo
  means the worst outcome is an alert that does nothing, rather than one that silently reverts
  something off screen.
- A rider who wants it gone entirely turns off **Settings → Accessibility → Touch → Shake to
  Undo**. Nothing in a web app can do that for them.

## 2. A ride is kept unless you say otherwise

The old sheet asked. That is defensible for a decision that is only interesting for thirty
seconds, and wrong for the only copy of something that took two hours to make — especially
once the sheet became the *only* place those figures ever existed. Now:

- the ride is written on arrival (`worthKeeping`, ≥ 200 m, still applies — a mis-tap on Start
  is silently discarded);
- the summary figures live in `RideStats.tsx`, used by both the finish sheet and the library,
  so the two can never disagree about what "average speed" means;
- a ride row in the library **opens**, showing those figures, the date, a rename field, Export,
  Delete, and *Ride it*.

## 3. Following a track you rode

This is the one that needed new parsing. A recorded ride is a `traceToGpx` document, and it
disagrees with BRouter's GPX about everything except the shape of a `<trkpt>`: no
`track-length` summary, no `time=`, and `<ele>` only where the app had a route to take a height
from. Read with `parseBrouterGpx` it comes back as a route of length zero, which the progress
bar then divides by.

`parseTrackGpx` therefore **measures** the distance from the track and sums the ascent with the
same 6 m deadband the route geometry uses — now shared, in `ascent.ts`, because three modules
wanted the same answer and two of them cannot import each other. That function is checked
against BRouter's own filtered figure on the London–Brighton fixture: **589 m against 592 m**.

A loaded track is drawn as `recorded`, a pseudo-profile that is deliberately *not* a member of
`PROFILES` — nothing routes with it and it must never appear in the comparison list, but it
needs a label and a colour. Orange `#ff7a3d`: C 72.7, L\* 66.2, and ΔE 23.7 clear of every
colour in both basemap palettes, so `style.test.ts` now iterates `ROUTE_PALETTE` rather than
`PROFILES`.

Two consequences worth knowing:

- **A reroute cannot use `chosen`.** `recorded` names no `.brf`, so asking the engine for it
  would fail at the exact moment a lost rider needs an answer. `plan.rerouteProfile` falls back
  to the ticked selection, which is the style this rider rides. (This was confirmed by
  accident: a browser test with two stale fake GPS watchers feeding fixes from two tracks at
  once went off route and rerouted cleanly on `trekking`.)
- **A track with no heights must say so.** `RouteGeometry.hasElevation` and `hasHeights()` are
  the same question asked of the geometry and of the parsed route. Where it is false the app
  drops the power column, the lookahead graph, the elevation profile and the climb list, and
  says why. A flat bar chart is not "no data" — it is a claim that the road ahead is level.

**Record mode** was the same ride with the route-shaped half absent: `Just record` in the
sheet, or the record button on the rail where no route was chosen. The HUD switched to what a
bike computer shows — speed, ridden, elapsed — because "to go" and "arrive" are functions of a
route and a permanent em dash reads as a broken app rather than a mode.

> **Withdrawn on 2026-09-10.** Riding with nothing to follow was a second app inside this one:
> a mode with its own figures, its own callout and its own reason for the panel not to fold,
> for a job a dedicated bike computer already does. Both entry points are gone and with them
> the `hasRoute` branch in `hud.ts` — every ride now follows a line, so the HUD is one shape.
> What it existed to feed is unaffected: **rides recorded while following a route are still
> saved**, and a saved ride's own track can still be put back on the map and followed, which is
> the half of the feature that was actually asked for.

## 4. The rider's marker

One size served both screens, and on the road it measured **20 logical pixels** — about the
size of a street label, in a blue close to the `fastbike` line, ringed in a pale grey that is
invisible against the light theme's near-white earth.

Now two sizes (`MARKER` in `routeLayers.ts`), switched by `setPositionEmphasis` on the two
transitions into and out of riding rather than on every fix: **45 px of arrow over a 34 px
halo** while riding, the old proportions while planning. The arrow is drawn at 64 device pixels
and scaled down rather than up, and carries **two rings** — white inside, a dark hairline
outside — so one image works over both basemaps with no repaint on a theme swap.

## 5. The HUD folds

The panel covered the top quarter of the screen, which is a lot of map at a junction. It now
has two sizes:

- **Full** — four figures, the 3 km lookahead, the whole-route bar, one line about the next
  hill.
- **Strip** — three figures, the whole-route bar, and the climb line **only when there is a
  climb within 1.2 km** (`hud.ts`). Collapsed, "Nothing steep left on this route" is a
  permanent sentence saying nothing, which is the noise the collapse was for — so the
  appearance of text on the strip is itself the signal.

1.2 km is more generous than the 700 m the voice uses, deliberately: a glance is cheaper than
an interruption, so the screen can afford to say it earlier than the speaker can.

### Why the transition is a measured pixel height

`ride.css` warns that animating a `backdrop-filter`ed stack's height judders on iOS, and that
warning is why the control rail collapses with transforms only. It does not transfer here: the
rail is seven blurred buttons and this is one panel, and it happens on a deliberate tap rather
than once a second.

What it *is* is measured. Both layers are absolutely positioned inside the panel and
cross-faded, so neither reflows during the animation, and a `ResizeObserver` on each reports
its height — because the strip's height is **not constant**: the climb line appears and
disappears inside it, and a hard-coded collapsed height would either clip that line or leave a
gap where it is not. The same mechanism is what makes the climb line *pop up* smoothly rather
than jumping.

Measured in a browser at 390×844: **185 px full, 96 px with the climb line, 62 px recording
with no route**, with the transition passing through 124 px mid-flight.

Two details that are load-bearing:

- `data-measured="no"` disables the transition until both layers have been measured. Without
  it the panel animates once, on arrival, from the CSS fallback to the first measurement.
- With **no route** the panel ignores the saved preference and shows its full self. Both sizes
  carry the same three figures then, the chevron is not drawn because there is nothing to
  collapse, and the one thing only the full layer has is the line explaining that this is a
  recording. A rider who collapsed the panel last ride would otherwise have no way to reach it.

## What is still unverified

Everything above was driven in a desktop browser against the real basemap and the real engine,
with a faked geolocation walking the route — which covers the wiring and none of the judgement.
Still needs a real ride:

1. **Is the strip enough?** Three figures and a 10 px bar, glanced at from a bar mount.
2. **Does the collapse transition hold up on iOS**, on a backdrop-filtered panel over a moving
   map, or does it judder the way the control rail did.
3. **Is the arrow now right, or overcorrected** — 45 px is large, and it covers the road it
   sits on at street zoom.
4. **Does the "Undo Typing" alert actually stop?** The fix removes the only text field on the
   riding path, which should empty the undo stack, but WebKit's behaviour here is inferred
   rather than documented.
