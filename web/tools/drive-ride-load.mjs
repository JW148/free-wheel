/**
 * Rides a real route over a real basemap in headless Chrome and counts what it cost.
 *
 * A ride drained a phone at about 1% a minute. This is the desk-side half of finding out why:
 * it starts a ride, walks a faked fix down the route at cycling pace, shakes a faked compass
 * the way a phone on a handlebar mount is shaken, and reads `window.freeWheelWorkload` — the
 * counters in `src/ride/workload.ts` — over a fixed minute per scenario. The numbers that come
 * out are map frames, compass events and the updates that reached React, fixes, renders of
 * the riding screen and camera moves, all per minute, plus the main thread's busy time from
 * CDP's own `Performance.getMetrics`.
 *
 * **What it cannot tell you is the battery.** Frames per minute is the input the GPU's power
 * draw follows; it is not the draw. Headless Chrome renders through SwiftShader, its
 * `requestAnimationFrame` is shimmed to a 16 ms timer (a hidden tab never fires a real one, and
 * MapLibre waits on it), and a ProMotion iPhone will draw up to twice as many frames for the same
 * camera move. Compare runs of this script with each other, never with a phone.
 *
 *     FW_BASEMAP=../data/basemap/london.pmtiles node tools/drive-ride-load.mjs <base-url> <out-dir>
 *
 * The basemap has to cover the start of `london-brighton.gpx`, which is the route ridden: without
 * one the app opens on "No map on this phone" and there is no map to count frames of.
 * `FW_SECONDS` shortens each scenario from its default of 60.
 */

import { mkdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { spawn, execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:4173'
const OUT = process.argv[3] ?? 'shots-load'
const BASEMAP = resolve(process.env.FW_BASEMAP ?? '../data/basemap/london.pmtiles')
const SECONDS = Number(process.env.FW_SECONDS ?? 60)
/*
 * 1 by default, and that is deliberate. SwiftShader draws a 3x frame slowly enough that the
 * main thread saturates and the frame count stops measuring how often the map *wanted* to draw
 * and starts measuring how fast the CPU can rasterise. At 1x a frame is cheap, so the count is
 * demand. `FW_DPR=3` is for looking at the pixels.
 */
const DPR = Number(process.env.FW_DPR ?? 1)
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

mkdirSync(OUT, { recursive: true })

// A Chrome left over from a previous run still owns 9222, and the new one silently fails to
// bind — so this would drive the old browser with the old profile. See the notes on drive.mjs.
try {
  execSync("pkill -f 'remote-debugging-port=9222'")
} catch {
  /* Nothing was running. */
}

const profile = mkdtempSync(join(tmpdir(), 'fw-load-'))
const chrome = spawn(CHROME, [
  '--headless=new',
  '--remote-debugging-port=9222',
  `--user-data-dir=${profile}`,
  '--window-size=500,900',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-first-run',
])
chrome.stderr.on('data', () => {})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const open = await (await fetch('http://127.0.0.1:9222/json/list')).json()
      for (const t of open) {
        if (t.type === 'page') await fetch(`http://127.0.0.1:9222/json/close/${t.id}`)
      }
      const res = await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' })
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
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails
    console.error('  ✗ ' + (d.exception?.description ?? d.text))
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    console.error('  ✗ ' + msg.params.args.map((a) => a.description ?? a.value).join(' '))
  }
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
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`))
    }, 60_000)
  })

const evaluate = async (expression) =>
  (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result
    .value

const click = (selector) =>
  evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return 'missing: ' + ${JSON.stringify(selector)}
    el.click()
    return 'ok'
  })()`)

async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'))
  console.log(`  → ${name}.png`)
}

/*
 * The route, seeded as the plan: three copies of real BRouter output, as drive.mjs does, so
 * the rider picks one and starts. No engine is needed for any of this.
 */
const gpx = readFileSync(new URL('../src/ride/__fixtures__/london-brighton.gpx', import.meta.url), 'utf8')
const points = [...gpx.matchAll(/lon="([-\d.]+)" lat="([-\d.]+)"/g)].map((m) => [+m[1], +m[2]])
const seed = {
  v: 4,
  waypoints: [
    { id: 'a', lon: points[0][0], lat: points[0][1] },
    { id: 'b', lon: points.at(-1)[0], lat: points.at(-1)[1] },
  ],
  selection: ['trekking', 'fastbike', 'gravel'],
  chosen: null,
  gpx: { trekking: gpx, fastbike: gpx, gravel: gpx },
}

/*
 * The fakes, installed before the app's own code runs.
 *
 * Geolocation is replaced outright rather than overridden through CDP, because a ride needs a
 * *moving* fix with a course and a speed, once a second, and `clearWatch` honoured — a watch
 * left running feeds two tracks at once and the app reroutes for no visible reason.
 *
 * The compass is `deviceorientation` at 60 Hz, which is what iOS delivers. A phone on a
 * handlebar mount reads the bike's weave — a few degrees either side at about half a hertz —
 * plus vibration noise of several degrees per sample off the road surface and the frame. The
 * figures are a model, not a recording: they are chosen to be plausible, and the comparison
 * that matters is the same model before and after a change.
 */
const FAKES = `
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16)
  window.cancelAnimationFrame = (id) => clearTimeout(id)
  ;(() => {
    const SPEED = 5.5
    const ride = (window.__ride = { walking: false, compass: false, alongM: 0, path: null })
    const rad = (d) => (d * Math.PI) / 180
    const metres = (a, b) => {
      const x = rad(b[0] - a[0]) * Math.cos(rad((a[1] + b[1]) / 2))
      const y = rad(b[1] - a[1])
      return Math.hypot(x, y) * 6371000
    }
    const bearing = (a, b) => {
      const y = Math.sin(rad(b[0] - a[0])) * Math.cos(rad(b[1]))
      const x = Math.cos(rad(a[1])) * Math.sin(rad(b[1])) - Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(rad(b[0] - a[0]))
      return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
    }
    function path() {
      if (ride.path) return ride.path
      const raw = JSON.parse(localStorage.getItem('free-wheel.plan.v2') || 'null')
      const doc = raw && raw.gpx && Object.values(raw.gpx)[0]
      if (!doc) return null
      const pts = [...doc.matchAll(/lon="([-\\d.]+)" lat="([-\\d.]+)"/g)].map((m) => [+m[1], +m[2]])
      const cum = [0]
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + metres(pts[i - 1], pts[i]))
      return (ride.path = { pts, cum })
    }
    function here() {
      const p = path()
      if (!p) return null
      let i = p.cum.findIndex((c) => c > ride.alongM)
      if (i <= 0) i = 1
      const a = p.pts[i - 1], b = p.pts[i]
      const t = Math.min(1, (ride.alongM - p.cum[i - 1]) / Math.max(1e-6, p.cum[i] - p.cum[i - 1]))
      return { lon: a[0] + (b[0] - a[0]) * t, lat: a[1] + (b[1] - a[1]) * t, heading: bearing(a, b) }
    }
    ride.here = here
    const position = () => {
      const h = here()
      return h && {
        timestamp: Date.now(),
        coords: {
          longitude: h.lon, latitude: h.lat, accuracy: 6, altitude: null, altitudeAccuracy: null,
          heading: ride.walking ? h.heading : null, speed: ride.walking ? SPEED : 0,
        },
      }
    }
    const watches = new Map()
    let nextWatch = 1
    const geo = {
      getCurrentPosition(ok) { setTimeout(() => { const p = position(); if (p) ok(p) }, 50) },
      watchPosition(ok) {
        const id = nextWatch++
        watches.set(id, setInterval(() => {
          if (ride.walking) ride.alongM += SPEED
          const p = position()
          if (p) ok(p)
        }, 1000))
        return id
      },
      clearWatch(id) { clearInterval(watches.get(id)); watches.delete(id) },
    }
    Object.defineProperty(navigator, 'geolocation', { get: () => geo, configurable: true })

    let noise = 0
    setInterval(() => {
      if (!ride.compass) return
      const h = here()
      if (!h) return
      const t = performance.now() / 1000
      // Box-Muller: vibration noise, sd 6 degrees per sample.
      const g = Math.sqrt(-2 * Math.log(Math.random() || 1e-9)) * Math.cos(2 * Math.PI * Math.random())
      noise = g * 6
      const heading = (h.heading + 4 * Math.sin(2 * Math.PI * 0.5 * t) + noise + 360) % 360
      window.dispatchEvent(
        new DeviceOrientationEvent('deviceorientation', { alpha: (360 - heading) % 360, beta: 70, gamma: 0, absolute: true }),
      )
    }, 16)
  })()
`

await send('Page.enable')
await send('Runtime.enable')
await send('Performance.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: DPR, mobile: true })

// The service worker serves the previous build; clear it before anything is looked at.
await send('Page.navigate', { url: BASE })
await sleep(1500)
await evaluate(`(async () => {
  for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister()
  for (const k of await caches.keys()) await caches.delete(k)
  localStorage.setItem('free-wheel.voice.v1', 'off')
  localStorage.setItem('free-wheel.onboarded.v1', 'yes')
  localStorage.setItem('free-wheel.courseup.v1', 'off')
  localStorage.setItem('free-wheel.plan.v2', ${JSON.stringify(JSON.stringify(seed))})
  return 'cleared'
})()`)
await send('Page.addScriptToEvaluateOnNewDocument', { source: FAKES })
await send('Page.navigate', { url: BASE })
await sleep(2500)

console.log(`importing ${BASEMAP}`)
// Nothing is installed yet, so the app opens on the maps gate, whose own "from files" link is
// the manual import.
await click('.maps-manual-toggle')
await sleep(700)
{
  const { root } = await send('DOM.getDocument')
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[accept=".pmtiles"]' })
  if (!nodeId) throw new Error('no .pmtiles file input on screen')
  await send('DOM.setFileInputFiles', { nodeId, files: [BASEMAP] })
}
for (let i = 0; i < 90; i++) {
  await sleep(1000)
  const state = await evaluate(`document.querySelector('.maps-manual .meta')?.textContent ?? ''`)
  if (/imported/i.test(state)) {
    console.log('  ' + state)
    break
  }
}
await sleep(2000)
await shot('load-00-imported')

/** Totals and the main thread's busy time, for differencing across a scenario. */
async function reading() {
  const snap = await evaluate(`window.freeWheelWorkload.snapshot()`)
  const { metrics } = await send('Performance.getMetrics')
  const metric = (name) => metrics.find((m) => m.name === name)?.value ?? 0
  return { at: Date.now(), totals: snap.totals, task: metric('TaskDuration'), script: metric('ScriptDuration') }
}

async function startRide(theme) {
  await evaluate(`localStorage.setItem('free-wheel.theme.v1', ${JSON.stringify(theme)})`)
  await evaluate(`localStorage.setItem('free-wheel.courseup.v1', 'off')`)
  await send('Page.navigate', { url: BASE })
  await sleep(3000)
  // No road data is imported — none is needed to follow a seeded route — so the gate that asks
  // for a region is up again on every launch. "Not now" is the rider's own way past it.
  await click('.setup-close')
  await sleep(1500)
  await click('.sheet-handle')
  await sleep(800)
  await click('.route-card-main')
  await sleep(600)
  await click('.route-card-start')
  await sleep(3000)
  await evaluate(`(window.__ride.walking = true, 'walking')`)
  await sleep(4000)
}

const results = []
async function scenario(name, setup) {
  await setup()
  await sleep(3000)
  const before = await reading()
  await sleep(SECONDS * 1000)
  const after = await reading()
  const minutes = (after.at - before.at) / 60000
  const row = { scenario: name }
  for (const key of Object.keys(after.totals)) row[key] = Math.round((after.totals[key] - before.totals[key]) / minutes)
  row['main thread s/min'] = +((after.task - before.task) / minutes).toFixed(2)
  row['script s/min'] = +((after.script - before.script) / minutes).toFixed(2)
  results.push(row)
  console.log(' ', JSON.stringify(row))
}

console.log('riding, light')
await startRide('light')
await shot('load-01-riding-light')

/*
 * The floor first: standing still, no compass, north-up. Nothing on the map has a reason to
 * move, so anything counted here is the app redrawing a picture that has not changed.
 */
await scenario('north-up, standing still, no compass', async () => {
  await evaluate(`(window.__ride.compass = false, window.__ride.walking = false, 'ok')`)
})
await scenario('north-up, GPS only', async () => {
  await evaluate(`(window.__ride.walking = true, 'ok')`)
})
await scenario('north-up, GPS + jittery compass', async () => {
  await evaluate(`(window.__ride.compass = true, 'ok')`)
})
await scenario('course-up, GPS + jittery compass', async () => {
  await click('[aria-label="Turn the map to face my way"]')
})
await shot('load-02-riding-courseup-light')
await scenario('course-up, stopped at lights, jittery compass', async () => {
  await evaluate(`(window.__ride.walking = false, 'ok')`)
})
await evaluate(`(window.__ride.walking = true, 'ok')`)
await click('.hud-collapse')
await sleep(800)
await shot('load-03-riding-folded-light')

console.log('riding, dark')
await startRide('dark')
await evaluate(`(window.__ride.compass = true, 'ok')`)
await sleep(4000)
await shot('load-04-riding-dark')
await click('.hud-collapse')
await sleep(800)
await shot('load-05-riding-folded-dark')

console.log('\n| scenario | ' + Object.keys(results[0]).slice(1).join(' | ') + ' |')
console.log('|---|' + Object.keys(results[0]).slice(1).map(() => '---').join('|') + '|')
for (const row of results) console.log('| ' + Object.values(row).join(' | ') + ' |')
writeFileSync(join(OUT, 'load.json'), JSON.stringify(results, null, 2))

ws.close()
chrome.kill()
