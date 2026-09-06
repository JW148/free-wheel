# Handoff — the unused safe area in the installed PWA

**Status: resolved and verified on the iPhone 17 Pro Simulator, iOS 26.5 (2026-09-06).** The
sections below are the original investigation; the resolution is at the end.

## The symptom

Add free-wheel to the iOS Home Screen, open it, and there is a dead band along the bottom of
the screen: the map stops short, and the action bar floats about 96px above the true bottom
edge instead of sitting just above the home indicator. In Safari as a normal tab it looks
correct. **The PWA is the intended use**, so this is the case that matters.

## The measurement

An on-screen probe (still present, see *Working tree* below) printed this from inside the
installed app on an iPhone 17 Pro Simulator, iOS 26.5:

```
b=<build>  ih=812  vv=812  svh=812  dvh=812  lvh=874  sabT=62  sabB=34
standalone=Y  ride=812@0  map=812  cv=874  barB=778
```

Read it as:

| | |
|---|---|
| `lvh` = 874 | the **real** screen height |
| `ih` / `vv` / `svh` / `dvh` = 812 | everything else agrees, and all are short |
| `sabT` = 62 | `env(safe-area-inset-top)` |
| `ride` = 812 @ top 0 | our root element, anchored at the top |
| `barB` = 778 | action bar's bottom = 812 − 34 padding |

**812 = 874 − 62.** In standalone, iOS sizes the layout viewport to the screen *minus the
status bar* but still anchors it at `top: 0`. So `position: fixed; inset: 0` — and every
viewport unit except `lvh` — stops 62px short of the bottom. The visible dead band is that
62px plus the 34px home-indicator padding applied inside it, which matches the ~96px seen.

This is **not** the same bug as the two previous safe-area fixes, both of which were real:

1. `box-sizing: border-box` was missing project-wide (Vite's template ships no reset), so
   `height: 100svh` set the *content* box and safe-area padding was added on top. Fixed in
   `src/index.css`, committed in `a1bf291`.
2. Before that, `inset: 0` in Safari let the collapsible toolbar bury the action bar, which
   is why `svh` was introduced in the first place. Still correct **for the browser case**.

The current bug is that `svh` is right in a tab and wrong in a standalone app.

## The fix as written (uncommitted, unverified)

In `web/src/ride/ride.css`:

```css
:root { --app-height: 100svh; }

@media (display-mode: standalone) {
  :root { --app-height: 100lvh; }
}
```

`.ride`, `.ride-chrome`, `.setup` and `.firstrun` changed from `inset: 0` / `height: 100svh`
to `inset: 0 0 auto; height: var(--app-height)`.

The vaul drawer is portalled to `<body>` and positioned against the viewport, so its
`bottom: 0` lands 62px high for the same reason. It gets pulled to the true edge with a
derived offset rather than a hardcoded one:

```css
@media (display-mode: standalone) {
  .drawer { bottom: calc(100svh - 100lvh); }   /* negative in standalone */
}
```

Why `lvh` is safe in standalone but not in a tab: there is no collapsible toolbar in a
home-screen app, so `lvh` is simply the screen. In a tab it is the height with the toolbar
hidden, which is exactly what buries controls.

## What is NOT verified

- **That the fix works.** Two relaunches after the change still showed `ride=812@0` and an
  identical probe string. The built CSS was confirmed to contain both `app-height:100svh` and
  `app-height:100lvh`, so the build is right — the app was almost certainly serving a cached
  bundle. This was not resolved before the run ended.
- Whether the MapLibre canvas resizes correctly once the container becomes 874 tall. The
  probe showed `map=812` (container) but `cv=874` (canvas) — the canvas was *already* the
  full height while its container was short. After the fix they should agree; check `cv`
  equals `map` equals `lvh`.
- Landscape, and any device without a Dynamic Island (where `sabT` will differ).

## How to verify

The build stamp is in the probe (`b=`) specifically so you can tell a stale bundle from a
failed fix. **If `b=` does not change after a rebuild, you are looking at the old bundle and
the layout numbers mean nothing.**

```bash
cd web && npm run build && npm run spike-server -- 4174
```

The PWA is already installed in the Simulator. `simctl` cannot launch it directly — its
bundle id is `com.apple.WebKit.PushBundle.<hash>` and launching that fails; the shared host
`com.apple.webapp` launches whichever web clip it feels like (it opened an unrelated one).
Launch it through Spotlight instead:

```bash
UDID=FA67207D-0138-488E-96DC-430D62387F85
SIMCTL=/Applications/Xcode.app/Contents/Developer/usr/bin/simctl   # not on PATH; see CLAUDE.md
$SIMCTL terminate $UDID com.apple.webapp            # force-quit, or iOS just resumes it
osascript -e 'tell application "Simulator" to activate' \
          -e 'tell application "System Events" to keystroke "h" using {command down, shift down}'
/tmp/simtap.sh 602 2152                             # the Search pill
osascript -e 'tell application "System Events" to keystroke "free-wheel"'
/tmp/simtap.sh 190 439                              # the Top Hit icon
$SIMCTL io $UDID screenshot /tmp/pwa.png
```

Expect after the fix: `ride=874@0`, `map=874`, `cv=874`, `barB=874−34=840`.

### Driving the Simulator — the two traps

`/tmp/simtap.sh` (recreate it if gone) converts a coordinate in *screenshot pixels*
(1206×2622) to a screen coordinate and clicks it. Both of these cost time to discover:

- **Re-read the window origin before every tap.** The Simulator window *moves* when
  activated — it went from x=1245 to x=1421 mid-session, and a cached origin silently taps
  176px off. Get it from the device-screen group, which is exactly the logical resolution:
  ```bash
  osascript -e 'tell application "System Events" to tell process "Simulator" \
    to tell window 1 to get position of (first UI element whose role is "AXGroup")'
  ```
  Screenshot pixel → screen: `origin + pixel/3` (the device is 3×).
- **Screen recording permission is denied**, so `screencapture` cannot see the Mac screen.
  `simctl io screenshot` works fine and is the only feedback loop available. Tap, screenshot,
  compare bytes to tell whether anything happened.

Keystrokes via System Events reach iOS and work well; taps only reach rendered content, and
menu items are not exposed as accessibility elements.

## Working tree

Uncommitted on `phase-4-ride-ui`, on top of `a1bf291`:

- `src/ride/ride.css` — the `--app-height` fix above.
- `src/ride/useMapLibre.ts` — unrelated: moves MapLibre's attribution control to bottom-left,
  because it shipped light-on-white in the bottom-right where the control column and action
  bar both live. This one **is** verified on device and is fine to keep.
- `src/ride/RideView.tsx` — contains a **temporary `ViewportProbe` component**, rendered into
  the rail hint, printing the numbers above. **Delete it once the fix is confirmed**; it is
  debug scaffolding, not a feature. It is the only reason `RideView` imports nothing new.

## If `lvh` turns out to be wrong too

The fallback is to stop trusting units and measure: set `--app-height` from JS off
`window.screen.height` or a `visualViewport` listener, writing a px value onto
`document.documentElement`. That is deterministic but adds a resize path to keep correct, and
it is why it was not the first choice. Do not go back to adjusting padding — padding was the
thing overflowing in bug (1), and adjusting it made that one steadily worse.

## Resolution

The `lvh` fix above was half the story. With it applied the probe read `ride=874`, `barB=840`
and the drawer's rect ran to 874 — and the screen still showed a dead band, with the action
bar cut off at 812 and the drawer's buttons clipped. The rects were right; the pixels were not.

Three markers placed across the 812 line — one `position: absolute` in the document, one
`fixed`, one `fixed` with a transform — all painted to the bottom of the screen, and the
difference was the absolute one: an in-flow box that reached past 812 made the document
itself taller. WebKit rasterises only the document's box, and a document made of nothing but
fixed children is exactly one layout viewport tall, so everything laid out below that line
was simply never painted. The band was the body colour showing through.

The fix in `ride.css`, under `(display-mode: standalone)`:

```css
html, body { min-height: 100lvh; overflow: hidden; }
```

Once the body is screen-high, iOS also reports `innerHeight`, `visualViewport.height` and
`dvh` as 874 (only `svh` stays at 812), and the fixed containing block grows with them. The
`.drawer { bottom: calc(100svh - 100lvh) }` correction proposed above therefore overshoots
by 62px once the body rule is in place, and was removed; the drawer's plain `bottom: 0`
lands on the true edge. `--app-height: 100lvh` for the fixed layers stays.

Verified: `ride=874 map=874 cv=874 barB=840`, drawer `112..874`, and the map paints to the
last row of pixels with the drawer both closed and open. The `ViewportProbe` is gone.
Still unverified: landscape, and a real device rather than the Simulator.
