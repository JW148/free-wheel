# What the road is made of, and where to turn — design

Written 2026-09-19. Agreed with the user across the brainstorming conversation of the same day.

Two features that look unrelated and are one change. BRouter already knows what surface every
metre of a route is laid with, which class of road it is, whether it is on the National Cycle
Network, and which way to turn at every junction. All of it is computed on every route the app
has ever run. None of it crosses into JavaScript, because `Router.java` asks `FormatGpx` for the
quietest output it has.

## The finding this rests on

`misc/profiles2/lookups.dat` is the tag vocabulary encoded into every `.rd5` tile, and it
carries:

| Key | Values |
|---|---|
| `highway` | cycleway, path, track, residential, unclassified, tertiary, secondary, primary, trunk, and 20 more |
| `surface` | asphalt, paved, unpaved, gravel, ground, dirt, grass, concrete, paving_stones, cobblestone, compacted, sand, wood, pebblestone, fine_gravel, earth, sett, mud, clay, and more |
| `smoothness` | excellent, very_good, good, intermediate, bad, very_bad, horrible, very_horrible, impassable |
| `tracktype` | grade1 to grade5 |
| `route_bicycle_ncn` / `rcn` / `lcn` / `icn` | yes, proposed |

`OsmPath` writes the decoded tag string onto `MessageData.wayKeyValues` for every segment, and it
does so on every route the app runs today. BRouter routes in two passes: the search, then a second
pass driven by the found track as a guide, and that second pass runs in detail mode, which is what
creates the `MessageData` at all. So the tags are already computed and already attached to the
track that comes back. `FormatGpx` emits them as `<brouter:way>` whenever they change, and emits
`<brouter:voicehint>`, `<desc>` and `<sym>` at every junction. Both are gated behind one thing:
`turnInstructionMode`, which is zero.

The last row of that table is the one worth stopping on. `docs/phase-5-progress.md` concluded
that cycle network data is absent, and it was right about the **basemap**: Protomaps ships no
`route=bicycle` relations. The routing tiles are a second dataset on the same phone and they
know network membership. Not the route number, only that a way belongs to one, so the app can
say "6.2 km on the National Cycle Network" and can never say "NCN 1".

## Decisions taken

Settled with the user before this was written.

| | Decision |
|---|---|
| Engine | `turnInstructionMode = 9` (trkpt/sym style), because it is the only mode emitting both `<brouter:way>` and `<brouter:voicehint>` |
| Where | `engine/src/main/java/btools/wasm/Router.java`, a file this repo owns. Nothing under `brouter-link/` |
| Output format | Still `FormatGpx`. No `FormatJson`, no `FormatCsv`, no second export |
| Parity corpus | Mode becomes an argument defaulting to 0, and `JvmRouteMain` runs all nine cases at **both** modes. Eighteen entries |
| Map treatment | Exceptions only. The route keeps its profile colour and picks up achromatic marks where the surface is not paved or the road is a main road |
| Sheet treatment | Full detail. A surface strip on the elevation profile's x-axis, plus a breakdown table, in chrome colours |
| Smoothness | Excluded from the first cut. In British data the largest row is Unknown, and a table whose biggest row is Unknown teaches riders to skip it |
| Turn-by-turn | In this spec, on the user's instruction, because it shares the engine change |
| Street names at turns | Out. The routing tiles carry no `name` tag |

## Delivery

One branch, staged commits, one PR, in the order the sections are numbered. The engine and the
corpus land first and together, because a half-changed corpus is a broken regression net. The
parser and `ways.ts` land next with their tests and nothing reading them. Then the sheet, then the
map, then the turns. Each stage leaves the app working.

## 1. The engine

`Router.route(String profile, String lonLats)` gains an overload taking a turn instruction mode,
with the existing two-argument form defaulting to 0 so the JVM parity harness can ask for either.

`RoutingContext` re-reads `turnInstructionMode` from the profile's own global variables when the
profile parses, which happens inside `RoutingEngine`, so assigning the field before construction
is not reliable. The supported path is a profile parameter through `RoutingParamCollector`, which
is what the Android app and the BRouter server both use. `routeIn` keeps its signature shape and
gains the mode alongside the two directories.

`EngineClient.route` passes 9. The JVM reference harness passes both.

Rebuild and commit:

```bash
cd engine
./gradlew buildWasmGC generateJavaScript
```

`web/public/engine/` is committed, so the regenerated artefacts go in with the change.

### The performance risk, and the fallback

`RoutingEngine` does extra work when `turnInstructionMode > 0`, and it is worth being precise
about how much. The way tags cost nothing: they come off the detail pass, which already runs. The
extra work is one constructed detour path per link that *diverges* from the guide track, during
that second pass only, so it is bounded by the length of the found route rather than by the size
of the search. That is a far smaller cost than the search itself.

It is still unmeasured in this project, and the app runs **three** profiles on a two-point plan.

The first build measures it on the phone against the 76 km London to Brighton case, which is
currently 4.5 s. The threshold is stated here so it is not argued about later: **if mode 9 costs
more than 25% on that case, the comparison run drops back to mode 0 and the chosen route is
re-run at mode 9 once the rider picks one.** That fallback is cheap to reach for because it
matches the UI already: the breakdown, the strip and the map bands all describe the chosen route
and nothing else.

Also measured in the first build: GPX size. `<brouter:way>` fires on every tag change and a saved
route is an IndexedDB record. London to Brighton is about 240 kB today.

## 2. The parity corpus

Parity as a property is untouched. `JvmRouteMain` calls `Router.routeIn`, which is the exact
method the browser calls, on purpose, so a mode change moves both sides identically and they
still agree byte for byte.

What goes stale is the recorded answers. `web/public/engine/jvm-routes.json` holds a byte length
and a CRC-32 per route measured at mode 0.

- `JvmRouteMain` runs each of the nine cases twice, once per mode, and writes eighteen entries
  keyed `<id>` and `<id>-ti9`.
- The browser-side replay in the diagnostics harness runs both.
- `web/src/ride/__fixtures__/urban-short.gpx` and `london-brighton.gpx` are regenerated at mode 9,
  because they exist to make `gpx.ts`'s coupling to `FormatGpx` break loudly. A third fixture at
  mode 0 stays, so the parser's handling of a route with no extensions is still covered.

Regenerating needs `data/segments4`, which is on this machine:

```bash
cd engine && ./gradlew jvmRoutes
```

## 3. Reading the extensions

`gpx.ts` keeps its regex approach and its reasoning. The input is still `FormatGpx`'s own output,
still one track point per line, and still has to parse in a Worker with no DOM.

`ParsedRoute` gains two optional arrays. Optional, not empty, because absence and emptiness are
different facts: a recorded ride has no ways at all, and a route across a field has ways but no
turns.

```ts
/** A stretch of road with constant tags, from `<brouter:way>`. */
export interface WayRun {
  fromM: number
  toM: number
  /** Raw decoded tags, e.g. `highway=cycleway surface=asphalt route_bicycle_ncn=yes`. */
  tags: Record<string, string>
}

/** A junction, from mode 9's `<sym>` and `<brouter:voicehint>`. */
export interface Turn {
  atM: number
  /** `TL`, `TSHR`, `KL`, `RNDB3`, `TU`, `C`, `BL`, `END`. BRouter's token, not prose. */
  command: string
  /** Roundabout exit, parsed out of `RNDB<n>` / `RNLB<n>`. */
  exit: number | null
}
```

Both are positioned by **track point index**, converted to metres through
`routeGeometry().cumulativeM`, which already exists and is already cached per route. Deliberately
not from `hint.distanceToNext`, which is a forward distance and would accumulate error.

`<sym>` is the parsed field and `<desc>` is ignored. `<desc>` is BRouter's English, and the app
speaks with its own wording and its own distance discipline (`spokenDistance` in `cues.ts` exists
because synthesisers read "450 m" as "four hundred and fifty em"). Parsing a token and writing our
own sentence is also what keeps the cue list testable without a fixture of English.

## 4. The taxonomy

A new `web/src/ride/ways.ts`, pure and tested, following what `search/kinds.ts` already does for
place kinds: the schema's vocabulary is not the rider's, and the translation belongs in a table
rather than scattered through components.

Three jobs.

**Classify a run.** Raw tags to one of five surface classes and one of four road classes.

| Surface class | From |
|---|---|
| `paved` | asphalt, paved, concrete, paving_stones, chipseal, metal, wood |
| `rough` | sett, cobblestone, grass_paver, pebblestone |
| `loose` | gravel, fine_gravel, compacted, ground, dirt, earth, sand, grass, mud, clay, unpaved |
| `unknown` | no `surface` and no `tracktype` |

`tracktype` fills in where `surface` is missing: grade1 reads as `paved` and every grade below it
as `loose`. An untagged way stays `unknown` and is never guessed at.

| Road class | From `highway` |
|---|---|
| `cyclepath` | cycleway |
| `path` | path, track, bridleway, footway |
| `road` | residential, unclassified, tertiary, living_street, service, and the `_link` forms of tertiary |
| `main` | primary, secondary, trunk, and their `_link` forms |

Tertiary is deliberately a `road`. A British tertiary is an ordinary lane, and marking one as a
main road on the map would mark most of the countryside.

**Aggregate.** Runs plus the route's total to a breakdown: length per road class, length per
surface class, and metres on the National Cycle Network from `route_bicycle_ncn=yes`. Sorted
descending, with everything past the fourth row folded into `Other`, because a twelve-row table
inside a drawer is a scroll.

**Mark the exceptions.** Runs to the two map marks, described in section 6.

## 5. The route details

Both additions live in the sheet's **detail** view, which is the one that already describes a
single chosen route, and both are absent when `hasHeights()` is false or the runs are missing.
That is the rule `hasElevation` already enforces for the power column and the climb list. A table
of zeros is a claim, not a gap.

### The surface strip

A band under `ElevationProfile`, sharing its 320 px width and its x-axis exactly, about 10 px
tall, drawn as one `<rect>` per run. Dragging the profile already moves a readout; that readout
gains a line naming the road class and the surface under the cursor, so "how bad is the bit at
8 km" gets a fuller answer than a gradient.

It is coloured by **road class**, not by surface, and there are two reasons. It is the question
the rider asked, which was that the map does not make it clear whether you are on a cycle path.
And surface already has a treatment on the map while road class has only the main-road casing, so
colouring the strip by road class is what leaves both dimensions visible somewhere. Four classes,
because `highway` is always tagged and there is no unknown.

Colour is free here, and `gradeScale.ts` records why: those are chrome colours on a panel we
control, and the C ≤ 15.4 stroke ceiling exists to stop a route line being mistaken for a road.
Nothing on a panel is on the map.

What is **not** free is the contrast window. `gradeScale.ts` also records that a band has to clear
3:1 on white and on `#11212d` at once, which confines every one to a relative luminance between
roughly 0.14 and 0.30. That window is about 2:1 wide, so four classes cannot be separated by
lightness. They separate on hue at roughly held lightness, and `chrome.test.ts` asserts the
contrast on both backgrounds the same way it does for the gradient bands.

### The breakdown

Below the climb list, because a climb changes the ride more than a surface does.

```
Road
  Cycle path        3.75 km
  Residential       2.27 km
  Minor road        0.58 km
  Main road         0.21 km
  Other             0.31 km
Surface
  Paved             7.59 km
  Rough             0.24 km
  Unknown           0.15 km
6.2 km on the National Cycle Network
```

Figure blocks are `<dt>` then `<dd>`, per the rule in `CLAUDE.md` that took from phase 4 to
phase 11 to find. The network line appears only when the distance is above zero, and it says
"on the National Cycle Network" rather than naming a route, because the data cannot name one.

`Unknown` earns its row here in a way it does not earn a map mark: a rider reading a table can
see that a tenth of the route is untagged, which is a fact about the map rather than about the
road.

## 6. The map

The chosen route keeps its profile colour along its entire length. Nothing about identity
changes, because six route hues at C ≥ 45 already fill the usable circle under the ΔE ≥ 16
clearance floor, and `routeLayers.ts` states the rule plainly: the ride overlays are achromatic,
and that is a rule not a preference.

Two marks, both achromatic, both drawn only for the `chosen` or `solo` route.

**Not paved.** A dashed centreline over the route at about 40% of the line's width, in the
theme's overlay ink, which is `#ffffff` on dark and `#06141b` on light. Those are the `OVERLAY`
colours `routeLayers.ts` already defines for the climb halo. It reads as stitching down the
middle of the line and leaves the profile colour visible either side. Covers both `rough` and
`loose`, folded together because the rider's question is "will this be slow and jarring" and the
two answers are the same.

**Main road.** A wider, darker casing under the route on those stretches. A second line in
`#06141b` beneath the existing `route-casing`, wider and more opaque, so the line gains weight
where the traffic does.

Everything else gets nothing, which is most of a British ride. The argument is the one `cues.ts`
already makes about speech: mark everything and the line becomes noise a rider learns to ignore,
mark only what changes a decision and a dashed stretch means something the first time it is seen.
An `unknown` surface gets no mark at all, for the same reason it does not get a guess.

Cycle paths get no mark on the route line either. They are the good case, the strip and the table
both name them, and the basemap's own `paths` layer already draws a cycleway solid at 2.4 px in
its own tone where a track or footway is dashed.

### Layers and order

A new source, `route-ways`, holding one feature per marked run with a `mark` property. Two layers,
at two different insertion points in the stack `ensureRouteLayers` builds:

| Layer | Goes | Because |
|---|---|---|
| `route-mainroad` | below `route-casing` | it *is* a casing, and has to sit under the coloured line |
| `route-unpaved` | above `route-line`, below `travelled` | it marks the line, and what is behind the rider should still grey out over the top of it |

`routeLayers.test.ts` asserts both positions. Insertion order is the kind of thing that looks
right on the day and silently inverts the next time a layer is added.

## 7. Turn-by-turn

### What the data gives, and what it does not

Mode 9 puts a `<sym>` on the track point at each junction carrying BRouter's command token, and
its roundabout exit number where there is one. The full set is continue, keep left and right,
slight, normal and sharp turns both ways, two kinds of U-turn, roundabout clockwise and
anticlockwise with an exit number, beeline, and end.

There are no street names. `lookups.dat` has no `name` key, so the `.rd5` tiles simply do not
carry them. Every instruction is "left in 200 metres" and never "left onto Mill Lane". Recovering
a name from the basemap archive at the turn's coordinate is possible and is **not** in this spec.

### Speech

New rules in `cues.ts`, which stays pure and stays the place the decision lives.

The existing discipline is the constraint worth designing against: every cue earns its place by
changing what the rider does in the next minute, and an app that talks constantly gets muted. A
route across a town has thirty junctions in eight kilometres. Announcing each one twice is sixty
utterances and a muted app, which says nothing at all.

So:

- **One utterance per turn.** Not a "prepare" and a "now".
- **Timed, not spaced.** The utterance fires roughly 15 seconds out at current speed, clamped
  between 60 m and 400 m. At 25 km/h that is about 100 m; walking a bike up a hill it is 60 m.
  A fixed distance is either too early in traffic or too late on a descent.
- **Chained.** A turn within 120 m of the one before it is folded into the previous utterance,
  as "Left, then right". This is what stops a junction pair becoming two interruptions that
  arrive on top of each other, and it is the same collapse every satnav makes.
- **Roundabouts carry the exit number** and get a longer lead, because the number has to be known
  before entering rather than at the entrance.
- **`C` (continue) is neither spoken nor shown.** BRouter emits it where a rider must ignore an
  obvious turning. That is a real instruction, and it is also the one that would fire most often
  in a town while asking for no action at all. The parser keeps it, because throwing data away at
  the boundary is how a later decision gets foreclosed; the presentation filters it.

Priority against the cues already there: off route first, because it invalidates everything else
that could be said about the route. Then turns, because a missed turn creates the off-route the
app is about to announce. Then arrival, climbs and descents, unchanged.

Keys follow the existing scheme so a cue is said once and a reroute cannot be blocked by the old
route's cues: `turn:<routeVersion>:<atM rounded>`.

`useAnnouncer` needs no change. Its three silent failure modes, the priming gesture, the queueing,
and the async voice list, are all already handled, and turns arrive through the same `cueFor`.

There is no separate setting for spoken turns in this cut. The mute toggle already on the riding
screen covers it. Whether a rider wants climbs but not turns is a real question and it is a
question for the road, not for a desk.

### On screen

The collapsed HUD strip carries exactly one conditional line today, and `hud.ts` states why: its
budget is one thing at a time, and text appearing on the strip is itself the signal.

That line becomes a slot with a priority, decided by a new pure function in `hud.ts`:

```ts
export type Callout =
  | { kind: 'turn'; command: string; exit: number | null; distanceM: number }
  | { kind: 'climb'; ahead: GradientAhead }

export function calloutFor(
  turn: Turn | null,
  climb: GradientAhead | null,
  input: { alongM: number; hasElevation: boolean },
): Callout | null
```

A turn inside 400 m takes the line. Otherwise the climb callout keeps it, on the existing
`CALLOUT_HORIZON_M` of 1.2 km. The expanded HUD has room for both and shows both.

The turn is drawn as a glyph and a distance: an arrow for the eight directions, a roundabout with
its exit number, a U-turn, and a flag for the end. Eleven glyphs, inline SVG, sized like the
chevron already on the panel. They are icons rather than pictures of the app, so the rule about
never hand-drawing the onboarding shots does not reach them.

Nothing is added to the map. A turn marker on the line was considered and left out: the line
already shows where it bends, and the riding screen refuses taps, so a marker there can only be
decoration.

## 8. Integration points

**Rerouting.** `stitch.ts` joins the road ahead onto the road already ridden and must offset both
new arrays along with everything else, or the surfaces and the turns describe the wrong
kilometres. `splitWaypoints` returns both halves from one function so they cannot disagree; the
runs and turns get the same treatment. `stitchRoute` already sets `resumeAtM` and that stays
load-bearing.

**Recorded rides.** `parseTrackGpx` produces neither array, and every consumer treats absence as
absence. No strip, no table, no map marks, no turn cues. Following a recorded track already sets
`plan.chosen` to the `recorded` pseudo-profile, and anything asking the engine for a profile must
keep using `plan.rerouteProfile`.

**The library.** Saved routes hold GPX, so a route saved after this change carries its tags and
its turns and reopens with them. A route saved before it does not, and opens with no strip and no
table rather than an empty one. No migration: the absence is already meaningful.

**Comparison.** The strip, the table and the map marks describe the chosen route. With three
routes on screen and `plan.chosen` still null, none of them appear. That is not a special case,
it is the same nullability the elevation profile and the stats rail already handle, and the
fallback was the bug the last time anything defaulted here.

## 9. Testing

| What | Where |
|---|---|
| 18-entry parity corpus green, Wasm against JVM | `jvm-routes.json`, diagnostics harness |
| Mode 9 extensions parse to runs and turns | `gpx.test.ts`, against regenerated verbatim fixtures |
| A mode 0 route still parses, with both arrays absent | `gpx.test.ts`, third fixture |
| Tag classification and the breakdown totals | `ways.test.ts`, new |
| Totals sum to the route length within rounding | `ways.test.ts` |
| Turn timing, the 60 m and 400 m clamps, chaining, `C` suppressed | `cues.test.ts`, extended |
| Cue budget over a real route | `cues.test.ts`, walking the Edinburgh fixture and counting |
| Callout priority between a turn and a climb | `hud.test.ts`, extended |
| Strip palette clears 3:1 on white and on `#11212d` | `chrome.test.ts` |
| Map marks are achromatic and the two insertion points hold | `routeLayers.test.ts` |
| Run and turn offsets survive a stitch | `stitch.test.ts`, extended |

Then `node tools/drive-stops.mjs`, which imports a real basemap and a real `.rd5` and runs an
actual BRouter route, at 390 x 844 in both themes.

## 10. What a desk cannot answer

In rough order of risk.

1. **The cost of voice hint processing on the phone.** Unmeasured, and three profiles run on
   every two-point plan. The 25% threshold and the fallback are in section 1.
2. **Whether turn cues are too chatty in a town.** Eight kilometres across Edinburgh is roughly
   thirty junctions. The chaining rule and the 15-second lead are the two levers, and both are
   guesses until somebody rides it.
3. **Whether the dashed centreline is legible in sunlight over all six route colours.** It is a
   lightness effect over a saturated line, which is the arrangement most likely to disappear on
   the light theme in daylight, and the light theme has itself never been outdoors.
4. **Whether a heavier casing reads as "main road" or as "chosen".** Width already carries state,
   and this adds weight to a line whose weight means something else.
5. **GPX size in the library.** Measured in the first build, not guessed at here.

## 11. Not in this spec

- **Street names at turns.** Would come from the basemap archive at the turn's coordinate, which
  is a lookup at a known point rather than a geocoder, so it stays compatible with the rule that
  there is no geocoder and there is not going to be one. A later decision.
- **A cycle network overlay across the whole map**, with route numbers. Needs a planetiler
  pipeline producing a second PMTiles archive per region, on the mirror side. Days of work and a
  second download per region.
- **Smoothness**, per the decision above.
- **Lifting the basemap's cycleway styling** off the path chroma ceiling. Worth doing, and worth
  doing after a ride shows whether the route bands settled the complaint on their own.
