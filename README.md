# free-wheel

Offline cycle route planner for iOS: the BRouter engine compiled to WebAssembly, running entirely
client-side in a PWA. No routing server, no tile server, no backend at all.

See `CLAUDE.md` for the architecture and the rules of the repo, and `docs/` for spike results.

## What it does

**Planning.** Tap a start and a finish, compare up to six riding styles at once on one pair of
elevation axes, and pick the one you want off the map or off the list. Every climb on the chosen
route is listed with where it starts, how much it gains and how steep it is. Routes save to a
library on the phone, and export as GPX.

**Riding.** The screen locks to you and answers four questions at a glance: how fast, how hard,
how far left, and what time you arrive. Under them, the next 3 km of road drawn as a gradient
strip, and one line naming the climb — or the descent — that is coming. Leave the route and it
routes again from where you are, through whatever waypoints are still ahead. The map can turn to
face the way you are going. And it speaks — sparingly, about five things, all of them the sort
you would rather hear than read: a climb coming up and how steep it is, the top of a hard one,
a long descent, going off route, and the finish.

**Afterwards.** The ride is recorded — distance, moving time, climbing, average and maximum
speed, and the work done — and can be kept or exported.

The power figure is estimated from speed, the route's own gradient and your weight, not measured;
Setup → Rider is where you tell it who you are, and it shows what your settings predict for two
familiar situations so you can check them against what you know you can hold.

## Prerequisites

- **Node** (tested on 26.x)
- **JDK 17+** — Homebrew's `openjdk@21`, with `JAVA_HOME` exported from `~/.zshenv`.
- `brouter-link/` — a symlink to a checkout of upstream BRouter. **Read-only; never modify it.**

## Build

```bash
# 1. JVM reference values, written to web/public/engine/jvm-reference.json
cd engine
./gradlew jvmParity

# 2. WasmGC + JS backends, written to web/public/engine/{wasm-gc,js}/
./gradlew buildWasmGC generateJavaScript

# 3. The PWA
cd ../web
npm install
npm run dev          # or: npm run build && npm run preview
```

### If the JDK ever "disappears"

`~/.zshenv` (in `/Users/jwig/`) supplies `JAVA_HOME`:

```bash
export PATH="/opt/homebrew/opt/openjdk@21/bin:$PATH"
export JAVA_HOME="/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home"
```

`JAVA_HOME` is the part that matters. `openjdk@21` is keg-only, so its `bin` is not symlinked into
`/opt/homebrew/bin`, and in practice the PATH line above does not survive into every shell —
`java` resolves to `/usr/bin/java`, the macOS stub, which works *only* by forwarding to
`JAVA_HOME`. Unset it and `java` fails with "Unable to locate a Java Runtime".

Two traps, both hit during Spike 1:

- **`~/.zshrc` is not enough.** zsh sources it only for *interactive* shells. Build tooling and
  agents run non-interactive shells, which read `~/.zshenv`.
- **It must be the `jwig` account.** Homebrew is owned by `joeadmin`, so it is tempting to do the
  setup there — but a profile in `/Users/joeadmin/` has no effect on builds run as `jwig`.

## Testing on a physical iPhone

The plan treats this as non-negotiable: desktop Safari and the Simulator both diverge from real
devices on storage and Wake Lock behaviour.

### Getting results off the device

The spike page has a **Send to laptop** button that POSTs the run to
`docs/spike-runs/<timestamp>.md`. That needs `npm run spike-server` (below) rather than
`npm run preview`, and it exists because every acceptance criterion is measured on the phone and
retyping 16 hex digits off a phone screen is how a mismatch gets recorded as a match.

There is also a **Copy report** button. Note `navigator.clipboard` is secure-context-only, so over
plain HTTP it falls back to `document.execCommand`, and failing that to a selectable textarea.

`docs/spike-runs/` is gitignored — promote the runs worth keeping into `docs/spike-N-results.md`.

### ⚠️ Anything touching OPFS needs HTTPS

`navigator.storage` is `[SecureContext]`, so on a plain-HTTP LAN origin it is **undefined** and
OPFS does not exist. Spike 1 runs fine over HTTP because it touches no storage; **Phase 1
onward does not.** (`http://localhost` *is* a secure context, so this only bites on a device.)

```bash
cd web
./tools/make-certs.sh          # local CA + server cert with your LAN IP in the SAN
npm run build
npm run spike-server-https     # https://<lan-ip>:4173
```

Then on the phone, once per device:

1. Open **`https://<lan-ip>:4173/ca.crt`** → Allow → the profile downloads
2. **Settings → General → VPN & Device Management → free-wheel local CA → Install**
3. **Settings → General → About → Certificate Trust Settings → enable full trust** for it.
   This second step is separate and easy to miss; without it Safari still rejects the cert.

`web/certs/` is gitignored. The CA private key never leaves the machine that generated it.
Delete the directory and re-run the script to rotate.

### Option A — over the LAN (Spike 1 only, no setup)

Enough for Spike 1: Web Workers, WebAssembly and Add to Home Screen all work over plain HTTP.
**Not enough for Phase 1** — see above.

```bash
cd web && npm run build && npm run spike-server   # binds 0.0.0.0, accepts POSTed reports
```

(`npm run preview` also works but has no report endpoint.)

Then open `http://<your-mac-lan-ip>:4173` on the phone, with both devices on the same network.
Vite prints the LAN address on startup.

⚠️ **The macOS application firewall is currently enabled on this machine and blocks incoming
connections to `node`.** The first `npm run preview` should raise a "Do you want the application
'node' to accept incoming network connections?" prompt — accept it. If no prompt appears, add node
under System Settings → Network → Firewall → Options, or use Option B, which needs no inbound
access at all.

⚠️ HTTP is **not** a secure context, so the service worker will not register. The spike page
reports this under "secure context". Fine for Spike 1; not enough for Spike 2, which needs
`navigator.storage.persist()` and offline caching.

### Option B — HTTPS via a tunnel (needed from Spike 2 onward)

No tunnel tool is installed on this machine. `cloudflared` is the lightest option and needs no
account for a quick tunnel:

```bash
# Homebrew here belongs to another user account, so install it user-locally:
mkdir -p ~/bin && curl -fsSL -o ~/bin/cloudflared \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz
# (extract, chmod +x, then:)
~/bin/cloudflared tunnel --url http://localhost:4173
```

That prints a `https://<random>.trycloudflare.com` URL. Open it on the phone, then **Share → Add
to Home Screen**, and launch from the icon — not from Safari, or `display-mode: standalone` will
report `no` and the results won't mean what you want them to.

## What to record from an on-device run

The spike page shows everything worth writing into `docs/spike-1-results.md`:

- whether both backends load at all under JSC
- whether every case still reads **bit-identical**
- the WasmGC-vs-JVM slowdown on the phone (the input to Spike 3's projection)
- whether `home-screen (standalone)` reports `yes`
