/**
 * Takes the six pictures the first run is built out of, from the app itself.
 *
 * The walkthrough used to draw pixel glyphs on the icon's own 20x14 grid. They were cheap and
 * they were also unreadable: twenty cells cannot say "three route cards you compare" or "a
 * panel that tells you about the hill ahead", and a rider looking at one had to be told what it
 * was. So the cards carry screenshots now — and a screenshot of a *mock* would be worse than a
 * glyph, because it would teach a screen that does not exist. This script is what keeps the
 * pictures the real thing: it drives the built app in headless Chrome over CDP against a real
 * basemap and real BRouter road data, plans a real route, rides it, and clips six rectangles
 * out of what it finds.
 *
 * ## It clips rather than shrinks, and that is the whole trick
 *
 * A 390 x 844 screen scaled into the card's ~334 x 287 tile lands at 34%: a silhouette, legible
 * nowhere, saying only "this is a phone". Each shot below therefore names a *rectangle* — the
 * plan card, the route cards, the riding panel — clipped at roughly life size, which is what
 * makes a rider recognise the thing they are about to use. `Page.captureScreenshot` takes a
 * `clip`, so the crop happens in the browser at full device resolution rather than in a
 * resampler afterwards.
 *
 * ## What it needs, and why none of it is checked in
 *
 * Three files, all far too large for a repository, all of which live outside it:
 *
 *     FW_BASEMAP   a .pmtiles archive covering the route below   data/basemap/probe/central-belt-z14.pmtiles
 *     FW_RD5       the BRouter segment covering it               data/segments4/W5_N55.rd5
 *     FW_PICKER    Britain at z0-10, for the region browser      data/basemap/probe/gb-z10.pmtiles
 *
 * The pictures it produces *are* checked in, under `web/public/onboarding/`, for the same
 * reason `public/engine/` is: a static host cannot build them.
 *
 * ## The mirror is stood in for, and only for the one screen that needs it
 *
 * The region browser reads `manifest.json` and streams the picker archive over HTTP range from
 * the mirror bucket. That bucket's first upload has never happened, so this run serves both
 * from a local fixture and rewrites `fetch` to point at it. The regions, their names and their
 * boxes come from `tools/mirror/regions.json` — the same file the mirror publishes from — so
 * the shapes in the picture are the shapes a rider will see. Their **sizes** are the one thing
 * the fixture cannot know, so that shot is clipped above the bar that states them: an invented
 * megabyte count is exactly the kind of thing a screenshot makes permanent.
 *
 *     npm run shots -- [--full] [--keep]        # or node tools/onboarding-shots.mjs
 *
 * `--full` skips the clipping and writes whole screens to `shots/onboarding/`, which is how a
 * rectangle gets chosen in the first place. `--keep` reuses the browser profile from the last
 * run, so the 86 MB import and the place index build do not happen again — the difference
 * between a two minute loop and a twenty second one while the crops are being settled.
 */

import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { segmentsForBbox } from './mirror/lib/geometry.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = dirname(HERE)
const FULL = process.argv.includes('--full')
const KEEP = process.argv.includes('--keep')
const OUT = FULL ? join(WEB, 'shots', 'onboarding') : join(WEB, 'public', 'onboarding')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const APP = 'http://127.0.0.1:4173'
const FIXTURES = 'http://127.0.0.1:4174'
const DATA_ORIGIN = 'https://free-wheel.fsn1.your-objectstorage.com'

/*
 * The three files it needs, defaulted to where `data/` keeps them.
 *
 * All three are gitignored and far too large to commit, so a fresh checkout has none of them
 * and the message says which one is missing rather than failing somewhere inside the browser.
 * The environment variables are for a custom extract; the defaults are what `npm run shots`
 * uses.
 */
const DATA = join(WEB, '..', 'data')
const need = (name, fallback) => {
  const path = process.env[name] ?? fallback
  if (!existsSync(path)) {
    throw new Error(`${name}: no file at ${path}. See the header of this script.`)
  }
  return path
}
const BASEMAP = need('FW_BASEMAP', join(DATA, 'basemap', 'probe', 'central-belt-z14.pmtiles'))
const RD5 = need('FW_RD5', join(DATA, 'segments4', 'W5_N55.rd5'))
const PICKER = need('FW_PICKER', join(DATA, 'basemap', 'probe', 'gb-z10.pmtiles'))

mkdirSync(OUT, { recursive: true })

/*
 * The two ends of the route the pictures are of.
 *
 * Typed into the app's own offline search rather than tapped onto the map, because a tap needs
 * a screen coordinate and a screen coordinate needs the map to already be where you want it —
 * where a name is just a name. They are far enough apart that the three riding styles disagree
 * about the way between them, which is the whole of what card three is about: two coincident
 * lines would illustrate the opposite claim. Both are inside `FW_BASEMAP`'s extent.
 */
const FROM = process.env.FW_FROM ?? 'south queensferry'
const TO = process.env.FW_TO ?? 'balerno'

/**
 * Where to tap for Central Scotland, on the screen the browser opens on.
 *
 * A point rather than a name because the region is chosen by tapping the map — see the shot
 * itself for why. The browser always opens by fitting all fourteen boxes into the same screen
 * at the same padding, so this is stable; if the published boxes ever change, the run prints
 * which region it actually landed on.
 */
const REGION_AT = [155, 330]

/**
 * How much of the screen the plan's two pins may span before the route shot pulls back.
 *
 * The card shows roughly the middle three quarters of a picture on a tall phone and less on a
 * short one, so this is well inside the 600 px the shot is clipped to rather than equal to it.
 */
const MARKER_BAND_PX = 330

// ── The mirror, stood in for ─────────────────────────────────────────────────────────────

const regions = JSON.parse(readFileSync(join(HERE, 'mirror', 'regions.json'), 'utf8'))

/*
 * A manifest describing what the real one will describe, minus the byte counts.
 *
 * `parseManifest` insists on a positive `bytes` for every asset, so there is no way to say
 * "unknown" through it. The ones below are placeholders and the region shot is clipped above
 * the only bar that would show one.
 */
const fixtureManifest = {
  version: 1,
  generated: new Date().toISOString(),
  picker: { url: 'picker/gb.pmtiles', bytes: statSync(PICKER).size },
  segments: Object.fromEntries(
    [...new Set(regions.flatMap((r) => segmentsForBbox(r.bbox)))].map((name) => [
      name,
      { url: `segments4/${name}.rd5`, bytes: 1, hash: name, changed: '' },
    ]),
  ),
  regions: regions.map((region) => ({
    ...region,
    basemap: { url: `basemap/${region.id}.pmtiles`, bytes: 1, hash: region.id, built: '' },
    segments: segmentsForBbox(region.bbox),
  })),
}

/**
 * Serves the manifest and the picker archive, with ranges.
 *
 * pmtiles reads an archive by `Range`, so a server that answers 200-with-everything to a ranged
 * request hands the library 61 MB where it asked for 16 kB of directory, and it then fails to
 * parse it. `vite preview` gets this right for the app's own assets; this is the same courtesy
 * for the two files that are not among them.
 */
const fixtures = createServer((request, response) => {
  const headers = {
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'content-range, content-length, etag',
  }
  if (request.url === '/manifest.json') {
    response.writeHead(200, { ...headers, 'content-type': 'application/json' })
    response.end(JSON.stringify(fixtureManifest))
    return
  }
  if (request.url !== '/picker/gb.pmtiles') {
    response.writeHead(404, headers)
    response.end()
    return
  }
  const total = statSync(PICKER).size
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '')
  if (!range) {
    response.writeHead(200, { ...headers, 'content-length': total, 'accept-ranges': 'bytes' })
    createReadStream(PICKER).pipe(response)
    return
  }
  const start = Number(range[1])
  const end = range[2] === '' ? total - 1 : Math.min(Number(range[2]), total - 1)
  response.writeHead(206, {
    ...headers,
    'accept-ranges': 'bytes',
    'content-range': `bytes ${start}-${end}/${total}`,
    'content-length': end - start + 1,
  })
  createReadStream(PICKER, { start, end }).pipe(response)
})
await new Promise((resolve) => fixtures.listen(4174, '127.0.0.1', resolve))

// ── The app, and a browser pointed at it ─────────────────────────────────────────────────

const preview = spawn('npx', ['vite', 'preview', '--port', '4173', '--strictPort'], {
  cwd: WEB,
  stdio: 'ignore',
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/*
 * A profile on disk rather than a temporary one, so `--keep` can reuse the imported archive.
 * OPFS lives in the profile, and importing 86 MB and indexing every name in it is two minutes
 * that has nothing to do with choosing a crop.
 */
const profile = KEEP ? join(WEB, 'shots', '.chrome-profile') : mkdtempSync(join(tmpdir(), 'fw-shots-'))
if (KEEP) mkdirSync(profile, { recursive: true })

const chrome = spawn(CHROME, [
  '--headless=new',
  '--remote-debugging-port=9223',
  `--user-data-dir=${profile}`,
  '--window-size=500,900',
  // `--disable-gpu` would leave MapLibre rendering nothing but its "no WebGL2" message.
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-first-run',
])
chrome.stderr.on('data', () => {})

async function target() {
  for (let i = 0; i < 80; i++) {
    try {
      const open = await (await fetch('http://127.0.0.1:9223/json/list')).json()
      // One tab at a time: OPFS allows one sync access handle per file, so a second tab
      // collides with the first and the app reports it cannot reach storage.
      for (const t of open) {
        if (t.type === 'page') await fetch(`http://127.0.0.1:9223/json/close/${t.id}`)
      }
      const res = await fetch('http://127.0.0.1:9223/json/new?about:blank', { method: 'PUT' })
      return (await res.json()).webSocketDebuggerUrl
    } catch {
      await sleep(250)
    }
  }
  throw new Error('Chrome never came up')
}

const ws = new WebSocket(await target())
await new Promise((r) => ws.addEventListener('open', r, { once: true }))

let nextId = 1
const pending = new Map()
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  const waiter = pending.get(msg.id)
  if (!waiter) return
  pending.delete(msg.id)
  if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)))
  else waiter.resolve(msg.result)
})

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })

const evaluate = async (expression) =>
  (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result
    .value

/* Anything the page threw, printed. A React tree with no error boundary renders nothing at all
   on a throw, and a screenshot of nothing looks exactly like a screenshot of a map that has not
   loaded yet — a failure this repo has already lost time to twice. */
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails
    console.error('  ✗ ' + (d.exception?.description ?? d.text))
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    console.error('  ✗ ' + msg.params.args.map((a) => a.description ?? a.value).join(' '))
  }
})

const click = (selector) =>
  evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return 'missing: ' + ${JSON.stringify(selector)}
    el.click()
    return 'ok'
  })()`)

/** Clicks whichever element matching `selector` reads `text`. */
const clickText = (selector, text) =>
  evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((e) => e.textContent.toLowerCase().includes(${JSON.stringify(text.toLowerCase())}))
    if (!el) return 'no ' + ${JSON.stringify(text)} + ' among ' + ${JSON.stringify(selector)}
    el.click()
    return 'ok'
  })()`)

/** Types into a controlled React input — through the prototype's setter, or React renders over it. */
const type = (selector, value) =>
  evaluate(`(() => {
    const field = document.querySelector(${JSON.stringify(selector)})
    if (!field) return 'missing: ' + ${JSON.stringify(selector)}
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(field, ${JSON.stringify(value)})
    field.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  })()`)

const text = (selector) =>
  evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent?.trim() ?? null`)

const present = (selector) =>
  evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)

/**
 * A tap on the map, at a point on the screen.
 *
 * Through `Input.dispatchMouseEvent` rather than a synthetic `MouseEvent`, because MapLibre
 * reads a click against the position of the press that preceded it — a lone click event has no
 * press to be within tolerance of. These are the real thing, so the whole gesture is one the
 * map already knows how to read.
 */
const tapMap = async (x, y) => {
  const where = { x, y, button: 'left', clickCount: 1 }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...where })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...where })
}

/**
 * Pulls the map back, about the middle of the screen.
 *
 * Two of the shots need it, and for the same reason: the app frames a route — and the region
 * browser frames Britain — to fill a 390 x 844 *screen*, and the card these end up on is
 * nowhere near that shape. Framed for the screen, cropping to the card loses both ends of the
 * route on the card about placing both ends of a route, and loses England off the card about
 * picking an area of Britain. One notch back and the subject fits the shape it is going to be
 * seen in.
 */
const zoomOut = async (notches) => {
  for (let i = 0; i < notches; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: 195,
      y: 422,
      deltaX: 0,
      deltaY: 120,
    })
    await sleep(500)
  }
  await sleep(1200)
}

/**
 * A rectangle out of the live screen, at device resolution.
 *
 * `clip` is in CSS pixels and `scale` multiplies it, so a 334 x 287 clip at scale 2 is a
 * 668 x 574 image: that rectangle at 1:1 on a 2x phone. Passed no rectangle it takes the whole
 * screen, which is what `--full` is for.
 */
async function shot(name, clip) {
  /*
   * WebP, and not PNG.
   *
   * These six are precached by the service worker, so their bytes are part of what a rider
   * downloads before the app will run offline — and six lossless screenshots of a *map* is
   * 6.2 MB, which is more than the routing engine. Map tiles are exactly the photographic-ish
   * content PNG is worst at: thousands of near-colours in the land fills and antialiased type
   * over them. At q82 the same six are a twentieth of that and the difference is invisible at
   * the size they are drawn.
   */
  const params = FULL ? { format: 'png' } : { format: 'webp', quality: 82 }
  if (clip && !FULL) params.clip = { ...clip, scale: 2 }
  const { data } = await send('Page.captureScreenshot', params)
  const file = `${name}.${FULL ? 'png' : 'webp'}`
  writeFileSync(join(OUT, file), Buffer.from(data, 'base64'))
  console.log(`  → ${file}`)
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true,
})

// The app precaches, so a rebuild changes nothing on screen until the previous service worker
// is gone. `Network.setCacheDisabled` does not help — a service worker is not the HTTP cache.
await send('Page.navigate', { url: APP })
await sleep(1500)
await evaluate(`(async () => {
  for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister()
  for (const k of await caches.keys()) await caches.delete(k)
  return 'cleared'
})()`)

await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    // A headless tab never fires rAF, and MapLibre's style loader awaits one — without this the
    // map never loads and reports no error at all.
    window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16)
    window.cancelAnimationFrame = (id) => clearTimeout(id)

    // The mirror, pointed at the fixture server. The picker archive is read by the pmtiles
    // protocol handler, which runs on this thread, so one patch covers the manifest and every
    // range read of the archive alike.
    const realFetch = window.fetch.bind(window)
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
      if (url.startsWith(${JSON.stringify(DATA_ORIGIN)})) {
        return realFetch(${JSON.stringify(FIXTURES)} + url.slice(${DATA_ORIGIN.length}), init)
      }
      return realFetch(input, init)
    }

    // The walkthrough is the thing being photographed. It must not be on screen while its own
    // pictures are taken.
    localStorage.setItem('free-wheel.onboarded.v1', 'yes')
    // --keep reuses the profile for its OPFS, not for its state: a plan left over from the
    // last run would put yesterday's route on today's picture, and the shortcut row that leads
    // to Setup is the plan card's *empty* state, so it would not even be reachable.
    localStorage.removeItem('free-wheel.plan.v2')
  `,
})

await send('Page.navigate', { url: APP })
await sleep(3000)

// ── Setting the phone up the way a rider's would be ──────────────────────────────────────

const setFiles = async (selector, files) => {
  const { root } = await send('DOM.getDocument')
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector })
  if (!nodeId) throw new Error(`no ${selector} on screen`)
  await send('DOM.setFileInputFiles', { nodeId, files })
}

const settle = async (seconds) => {
  for (let i = 0; i < seconds; i++) {
    await sleep(1000)
    if (/imported|^$/i.test((await text('.maps-manual .meta')) ?? '')) return
  }
}

/* The gate is the signal: it is up exactly when this phone has nothing to ride on, which after
   a `--keep` run it does. */
if (await present('.setup-close')) {
  console.log('importing a map and its road data')
  await click('.setup-close')
  await sleep(600)
  await click('.plan-shortcuts button:nth-child(2)')
  await sleep(600)
  await click('.setup-menu-row:nth-child(1)')
  await sleep(900)
  await click('.maps-manual-toggle')
  await sleep(700)
  // 86 MB into OPFS, and then the place index reads all of it back out again.
  await setFiles('input[accept=".pmtiles"]', [BASEMAP])
  await settle(150)
  await sleep(3000)
  await setFiles('input[accept=".rd5"]', [RD5])
  await settle(90)
  await sleep(2000)
} else {
  console.log('already provisioned')
  await click('.plan-shortcuts button:nth-child(2)')
  await sleep(700)
  await click('.setup-menu-row:nth-child(1)')
  await sleep(1400)
}

// ── Card 2. Pick an area of Britain ──────────────────────────────────────────────────────

/*
 * Taken first, and from inside Maps, because it is the one screen that wants nothing installed
 * behind it: a region already on the phone paints in the "installed" colour, and the picture is
 * then of a decision already made rather than one being offered. The archive imported above is
 * not a *region*, so the browser still reads all fourteen as available.
 */
console.log('the region browser')
await click('.maps-add')
await sleep(5000)
/*
 * Chosen on the map rather than out of the list, and that is the difference between a picture
 * of Britain and a picture of one region. Picking from the list *frames* what it picked — a
 * name means nothing until you can see where it is — which zooms past the other thirteen. A
 * tap moves nothing, so the country stays whole with one area lit inside it, which is what the
 * card underneath it claims: pick an area of Britain.
 */
await tapMap(REGION_AT[0], REGION_AT[1])
await sleep(2000)
console.log('  chose: ' + ((await text('.sheet-profile')) ?? 'nothing'))
await zoomOut(2)
await shot('regions', { x: 0, y: 122, width: 390, height: 600 })

await click('.browse-back')
await sleep(900)
await click('.setup-close')
await sleep(700)
await click('.setup-close')
await sleep(1500)

// ── Cards 3 and 4. Two taps, three routes ────────────────────────────────────────────────

const planRoute = async () => {
  await click('.map-search')
  await sleep(900)
  await type('.search-field', FROM)
  await sleep(1400)
  await click('.place-row')
  await sleep(1400)
  await type('.search-field', TO)
  await sleep(1400)
  await click('.place-row')
  // Three profiles, each a real BRouter run over the imported segment.
  for (let i = 0; i < 40; i++) {
    await sleep(1000)
    if (/\d+ min/.test((await text('.plan-sheet')) ?? '')) break
  }
  await sleep(2500)
}

console.log('planning a route')
await planRoute()
console.log('  ' + ((await text('.plan-sheet')) ?? 'nothing').replace(/\s+/g, ' ').slice(0, 160))

/*
 * The search leaves the sheet open on the comparison, which is card four exactly.
 *
 * Framed by measuring the sheet rather than by a constant, and for the same reason the two
 * shots below are: the sheet has no fixed height. It grew when the plan's own points were
 * listed in it, and the `y: 244` this used to be then cut the heading in half — a picture of a
 * screen with its title sliced off, which is worse than no picture. Twenty pixels of map above
 * the top edge is what says this is a sheet over a map rather than a page.
 *
 * Six hundred pixels from there reaches the three cards and "More riding styles" and stops
 * short of the point list and the actions, which is the right subject: the card this
 * illustrates is about three routes you compare, not about editing the plan.
 */
const sheetTop = await evaluate(
  `Math.round(document.querySelector('.plan-sheet')?.getBoundingClientRect().top ?? 244)`,
)
await shot('compare', {
  x: 0,
  y: Math.max(0, Math.min(844 - 600, sheetTop - 20)),
  width: 390,
  height: 600,
})

/*
 * And put away, which is card three: the lines on the map, with both ends of the plan on it.
 *
 * Framed by measuring rather than by guessing. The app fits a route to a 390 x 844 screen and
 * the card is nowhere near that shape, so the two pins — the literal subject of "tap your
 * start, tap your finish" — fall outside the crop at whatever zoom the app chose. This pulls
 * back until both markers sit inside the band the card will actually show, then centres the
 * window on them. A route's shape is not known in advance and neither is the zoom it needs, so
 * the alternative is a constant that is right for one route.
 */
await click('.sheet-handle')
await sleep(1200)

/** The top and bottom of the screen band the plan's markers occupy, in CSS pixels. */
const markerBand = () =>
  evaluate(`(() => {
    const rects = [...document.querySelectorAll('.maplibregl-marker')].map((m) => m.getBoundingClientRect())
    if (rects.length < 2) return null
    return { top: Math.min(...rects.map((r) => r.top)), bottom: Math.max(...rects.map((r) => r.bottom)) }
  })()`)

let band = await markerBand()
for (let i = 0; i < 12 && band && band.bottom - band.top > MARKER_BAND_PX; i++) {
  await zoomOut(1)
  band = await markerBand()
}
console.log(`  pins span ${band ? Math.round(band.bottom - band.top) : '?'}px`)
/* Clamped to 100 so the bottom edge stays clear of the plan card, whose white corner would
   otherwise appear in the picture as an unexplained sliver. */
const routesY = band
  ? Math.max(0, Math.min(100, Math.round((band.top + band.bottom) / 2 - 300)))
  : 100
await shot('routes', { x: 0, y: routesY, width: 390, height: 600 })

// ── Card 1. The app, before anything is asked of it ──────────────────────────────────────

/*
 * Taken after the route rather than before, because clearing a plan leaves the map where the
 * route framed it — a street-level view of somewhere real, which is what a rider's own first
 * screen looks like. Before the route it is the whole central belt at z8, which is a map of
 * nothing in particular.
 */
console.log('the map, with nothing on it')
await click('.sheet-handle')
await sleep(900)
console.log('  ' + (await clickText('.sheet-actions button', 'clear')))
await sleep(1200)
await click('.sheet-handle')
await sleep(1200)
await shot('plan', { x: 0, y: 244, width: 390, height: 600 })

// ── Cards 5 and 6. On the road ───────────────────────────────────────────────────────────

console.log('riding it')
await send('Browser.grantPermissions', { permissions: ['geolocation'] })
await planRoute()
await click('.sheet-handle')
await sleep(1000)
await click('.route-card-main')
await sleep(900)
await click('.route-card-start')
await sleep(4000)

/*
 * A rider actually moving, rather than parked on the start line.
 *
 * Standing still the panel reads "—" for speed and for power, 0.0 km ridden and the whole route
 * still to go — every figure on it in its empty state, which is a poor advertisement for a
 * panel whose entire job is figures. So the fix is walked along the chosen route's own
 * coordinates, with a `speed` on each, and the app's telemetry does the rest: the progress bar
 * fills, the distance to go falls, the ascent accumulates and the climb line names the next
 * hill from where the rider now is.
 */
const track = await evaluate(`(() => {
  const plan = JSON.parse(localStorage.getItem('free-wheel.plan.v2') ?? '{}')
  const gpx = plan.gpx?.[plan.chosen] ?? Object.values(plan.gpx ?? {})[0]
  if (!gpx) return []
  // BRouter writes lon before lat, which is the opposite of the order they are read in.
  return [...gpx.matchAll(/<trkpt lon="([-\\d.]+)" lat="([-\\d.]+)"/g)]
    .map((m) => [Number(m[2]), Number(m[1])])
})()`)
console.log(`  ${track.length} track points`)

/* `speed` and `heading` are newer additions to the override; an older Chrome rejects the whole
   call rather than ignoring them, which would leave the rider stranded at the start. */
let withMotion = true
const fixAt = async (index, speedMps, heading) => {
  const [latitude, longitude] = track[Math.min(index, track.length - 1)]
  const params = { latitude, longitude, accuracy: 6 }
  if (withMotion) {
    try {
      await send('Emulation.setGeolocationOverride', { ...params, speed: speedMps, heading })
      return
    } catch {
      withMotion = false
      console.log('  (this Chrome has no speed on the geolocation override)')
    }
  }
  await send('Emulation.setGeolocationOverride', params)
}

if (track.length > 40) {
  // A fifth of the way along, in a few steps, so `progress.ts` sees movement rather than a
  // teleport and the recorded distance is a real sum of real legs.
  for (const fraction of [0.02, 0.06, 0.1, 0.14, 0.18, 0.2]) {
    await fixAt(Math.floor(track.length * fraction), 6.4, 96)
    await sleep(1200)
  }
}
await sleep(2500)
console.log('  ' + ((await text('.hud')) ?? 'no hud').replace(/\s+/g, ' ').slice(0, 140))

/* Which size the panel is in is remembered across a session, so neither state can be assumed —
   it is asked for, and toggled only if the answer is wrong. */
const hudExpanded = () =>
  evaluate(`document.querySelector('.hud-collapse')?.getAttribute('aria-expanded') === 'true'`)
const setHud = async (wanted) => {
  if ((await hudExpanded()) === wanted) return
  await click('.hud-collapse')
  await sleep(1400)
  if ((await hudExpanded()) !== wanted) throw new Error(`the panel would not go ${wanted ? 'open' : 'shut'}`)
}

// Open onto its graph, which is card five: the climb ahead, the power, the four figures. This
// is the card that has to say "it tells you about the hill before you see it".
await setHud(true)
await shot('ride', { x: 0, y: 0, width: 390, height: 600 })

// Folded away, the map is the screen — the rider on the line, and the road ahead. Card six.
await setHud(false)
await shot('follow', { x: 0, y: 130, width: 390, height: 600 })

console.log(FULL ? `\nwhole screens in ${OUT}` : `\nsix pictures in ${OUT}`)

ws.close()
chrome.kill()
preview.kill()
fixtures.close()
if (!KEEP) rmSync(profile, { recursive: true, force: true })
