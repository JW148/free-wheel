# Phase 14 — the first run shows the app

Implemented 2026-09-18, from one observation and one request: the six pixel glyphs the
walkthrough drew were unreadable — nobody could tell what they were supposed to be — and once
the walkthrough was finished there was no way back into it.

The fix is not better glyphs. It is that each card now shows **the screen it is about**, clipped
out of the running app — so a rider arrives at the ride screen already knowing what they are
looking at, which is the only thing a walkthrough is for.

---

## 1 · Why the glyphs could not have worked

They were a good idea on paper and `CLAUDE.md` recorded the reasoning: character maps on the app
icon's own 20 x 14 grid, no licensing, no bytes, nothing to 404 on a cold cache. The note beside
them even recorded the limit — *"a glyph is a silhouette with one accent, and anything more
detailed dissolves. Two whole bikes side by side read as a pair of spectacles, which is why that
card is two wheels."*

That limit is the argument against them. Two of the six cards are about *comparing* things —
three routes on a map, three cards with times and distances against each other — and one is
about a panel carrying four figures and a graph. Twenty cells across cannot draw any of that. A
glyph that has to be explained by the paragraph under it is decoration, and the paragraph was
already doing the work.

## 2 · The pictures are of the running app, and that is load-bearing

`web/tools/onboarding-shots.mjs` drives the built app in headless Chrome over CDP, the same way
`drive.mjs` does and around the same four traps. It:

- imports a real basemap (`central-belt-z14.pmtiles`, 86 MB) and a real BRouter segment
  (`W5_N55.rd5`, 26 MB) through the app's own manual-import path;
- opens the region browser and taps Central Scotland on the map;
- types *South Queensferry* and *Balerno* into the app's own offline place search, and waits for
  three real BRouter runs to land — 20.2 km / 191 m, 18.0 km / 253 m, 19.2 km / 243 m;
- clears the plan for the first card, then plans it again, starts the ride, and **walks the fix
  along the chosen route's own coordinates** so the riding panel reads 23.0 km/h, 325 W, 13 km
  to go and a real next climb rather than six dashes;
- clips six rectangles and writes them to `web/public/onboarding/*.webp`.

**A mock would have been worse than the glyph it replaced.** A picture of a screen that does not
exist teaches a screen that does not exist, and the rider then meets a different one. Everything
below is in service of not having to draw anything.

### The two things that are stood in for, and why only those

The **mirror** is: the bucket's first upload has never happened, so the region browser is served
a fixture manifest built from `tools/mirror/regions.json` — the same file the mirror publishes
from — and the picker archive (`gb-z10.pmtiles`, the measured 61 MB) over a local range-serving
HTTP server, with `fetch` rewritten in the page. The regions, their names and their boxes are
therefore exactly what a rider will see.

Their **sizes** are not, and cannot be: `parseManifest` requires a positive `bytes` for every
asset, so the fixture must invent one. That shot is clipped **above the bar that states it**. A
screenshot makes an invented figure permanent, and "under 0.1 MB · map and road data" under a
region that is really a few hundred megabytes is the kind of thing that ends up quoted back.

## 3 · Clipped, not shrunk

A whole 390 x 844 screen scaled into the card's tile lands at about a third. That is a
silhouette: legible nowhere, and saying only *this is a phone*. So each shot names a rectangle —
the plan card, the route cards, the riding panel — and it is drawn at around 86%, which is the
difference between a picture of the app and a picture of a phone.

`Page.captureScreenshot` takes a `clip` with its own `scale`, so the crop happens in the browser
at full device resolution rather than in a resampler afterwards.

### The tile takes a share of the screen, and the picture crops to fit

Neither obvious option works:

- **A fixed aspect ratio** pushes the text off a short phone.
- **`flex: 1`** absorbs every spare pixel and floats the text away from the top, which is where
  a card that has to be read wants it — and is what the brief asked for.

So the tile is `clamp(190px, calc(var(--app-height) * 0.44), 420px)`, the picture covers it, and
`Slide.focus` decides which part survives: the top of the riding panel, the bottom of the plan
card, the middle of a map. The frame is the app's own panel vocabulary — `--r-panel`,
`--lift-panel`, a hairline ring — because that is what it is: a panel with a screen inside it.
The ring is a `::after` rather than an `inset` shadow, which paints *under* the image and would
never be seen.

### Two of the six are framed by measuring, not by a constant

The app fits a route to a 390 x 844 screen, and the card is nowhere near that shape. At the
app's own zoom both pins — the literal subject of *"tap your start, tap your finish"* — fall
outside the crop, and the first pass produced a card about placing two points with neither point
on it. The script now reads the markers' rects, wheels the map back until they span under 330 px,
and centres the window on them. `330` rather than the full 600 the shot is clipped to, because
the card shows roughly the middle three quarters of a picture on a tall phone and less on a
short one.

The region browser needed the same treatment for the same reason, or England falls off the card
about picking an area of Britain. Framing it from the *list* is worse than useless here: picking
from the list moves the map to that region, which is right in the app and wrong in a picture
that has to say "Britain". So it is chosen with a real `Input.dispatchMouseEvent` tap, which
`BrowseMap` deliberately does not move the map for.

## 4 · WebP, and what it cost

Six lossless screenshots of a *map* are **6.2 MB** — more than the routing engine, and all of it
precached, because the walkthrough runs before anything has been downloaded. Map tiles are
exactly what PNG is worst at: thousands of near-colours in the land fills with antialiased type
over them. At q82 the same six are **732 kB** and the difference is invisible at the size they
are drawn. `globPatterns` gains `webp`; the precache goes from 5.4 MB to 6.1 MB.

## 5 · The short-phone budget, which is one card's problem

Five of the six cards are a picture and two paragraphs and fit anywhere. The sixth also carries
the bike chips — and at 375 x 667 the share above pushed them 89 px under the pager, so the only
question the walkthrough actually asks was answerable only by scrolling a card that gives no
sign it scrolls.

One `@media (max-height: 740px)` block takes the picture to 32% and the gaps from 1.3 rem to
0.9 rem, which is 107 px. The card stays a scroller — a long enough translation will always beat
any budget — but it no longer needs to be one on a phone anybody has.

## 6 · And a way back into it

Finished, the walkthrough was unreachable. Six cards explaining the app, retired after one
viewing — in an app whose whole premise is on card two, and whose riders meet that premise again
every time they go somewhere new.

It is the third row in Setup, *How this app works*, under Maps and the rider: a rider opens
Setup to download a region, not to read. A line of text beside Diagnostics would have been
cheaper and wrong — the two riders who want this are the one in their first week and the one
coming back after a winter, and they are exactly the two least likely to go looking in the small
print.

### Shown again, it reports rather than asks

The bike card is the whole problem. It writes three settings — `style`, `position`, `tyres` —
that stay individually editable in *You and the bike*, so a walkthrough reopened to read about
downloads and closed again would have written the default hybrid over whatever the rider had
set. Three changes, all guarding that:

- The chips start on `bikeFor(rider.setup)`, which matches on **all three fields** and returns
  `null` when none of the four describes the rider. `style` alone would not do: gravel and
  mountain share a profile and differ on tyres by nearly 2x in rolling resistance.
- `onDone` takes `BikeChoice | null`, and `null` writes nothing. Reading the cards is read-only.
- The last card stops asking for location and its button says *Done*. Location has been offered
  once already, and a browser that was refused will not prompt a second time however the button
  is worded — so *Allow location & start* would have been a button that does nothing.

`App` owns which of the two lives the walkthrough is in, because they stack the opposite way
round: the first run **covers** the maps gate (both are full-screen and opaque, and stacking
them flashes Setup on every first launch), while a revisit is drawn **over** Setup, which has to
still be there to come back to.

## Verified

`npx vitest run` — **718 green**, from 715. Three glyph tests went with `glyphs.ts`, three
picture tests replaced them, and three more cover `bikeFor`. The useful picture test asserts
**every name a card asks for has a file on disk**, which is the one failure a screenshot has
that a drawing does not, and which nothing else in the build would have said a word about.
`tsc -b` and `npm run build` clean; `npm run lint` reports the same 46 warnings with the change
as without it, all of them in files this phase did not touch.

`tools/drive.mjs` at a true 390 x 844, all six cards. Separately at **375 x 667**, where the
measured overflow on the bike card went from 89 px to 0, and on the dark theme, which is
unreachable in practice — a rider with dark set has already onboarded — but does not look
broken.

`drive.mjs` also walks the Setup row, and through the state that matters: it first picks a tyre
in *You and the bike* that no bike answer produces, opens the walkthrough and prints
`chips lit: 0`, then finishes and compares `free-wheel.rider.v1` before and after —
`rider untouched: true`. That last line is the invariant the whole revisit turns on, and it
costs one `evaluate` call.

Two traps cost a pass each and are worth recording:

- **`vite preview` serves a stale `index.html`.** It must be restarted after a rebuild, or a
  driven run photographs the previous bundle. This looks exactly like a change that did not
  apply.
- **`drive.mjs` talks to whatever is already on port 9222.** A leftover Chrome from an earlier
  run answers `/json/new` with *its* profile, so the walkthrough appears to have been skipped —
  which reads as an onboarding bug and is not one.

## Not done, and what a desk cannot answer

1. **Still not ridden.** Phases 7–14 are now all unridden.
2. **Whether 730 kB of precache is the right price** for a screen shown once. It is defensible
   because the walkthrough is the first thing a rider sees and must work in a tunnel on the
   second launch, but nobody has watched a cold first load on a phone over cellular.
3. **Whether the pictures survive their own map.** They are screenshots of the *light* basemap,
   and the basemap is regenerated from dated Protomaps builds. Nothing fails when the style
   drifts; the pictures quietly stop matching the app. Re-running the script is cheap
   (`--keep`), but nothing prompts it.
4. **Whether the clipped region shot reads as "pick an area of Britain"** without the bar that
   names the region and states its size. On a desk it does. The bar is the only thing that says
   the map is a *control*.
5. **Whether the 375 x 667 layout is comfortable rather than merely fitting.** The picture is
   213 px there and cuts through the third route card.
6. **Whether a rider ever finds the Setup row.** It is discoverable by anyone who opens Setup,
   which is everyone at least once, but nothing points at it from the ride screen. If the
   walkthrough turns out to be worth *suggesting* rather than merely offering, the place for
   that is the Layers sheet's Setup row, not a banner.
