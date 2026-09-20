/**
 * Drives the built app through the surface breakdown and the turn instructions.
 *
 * The third driver, and it exists for the same reason the second one does: this flow cannot be
 * faked from a seeded plan. What is being looked at is data BRouter writes into the GPX, so the
 * engine has to actually run against real routing tiles — a seeded fixture would show the
 * strip drawn from whatever was seeded rather than from what the engine said.
 *
 * It shares every trap the other two work around, because they are properties of headless
 * Chrome rather than of any script: the service worker serving the previous build, a hidden tab
 * never firing `requestAnimationFrame` (which MapLibre's style loader awaits, so the map
 * silently never loads), one OPFS sync handle per file so only one tab may be open, and
 * `--disable-gpu` killing WebGL2 outright.
 *
 *     npm run build && npx vite preview --port 4173 &
 *     node tools/drive-surface.mjs [base-url] [out-dir] [--keep]
 *
 *     FW_BASEMAP   a PMTiles extract          data/basemap/edinburgh.pmtiles
 *     FW_RD5       the segment covering it    data/segments4/W5_N55.rd5
 */

import { mkdirSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const BASE = process.argv.find((a) => a.startsWith('http')) ?? 'http://127.0.0.1:4173'
const OUT = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 'shots/surface'
const KEEP = process.argv.includes('--keep')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const DATA = resolve(process.cwd(), '..', 'data')

const need = (name, fallback) => {
  const path = process.env[name] ?? fallback
  if (!existsSync(path)) throw new Error(`${name} not found at ${path}`)
  return path
}
const BASEMAP = need('FW_BASEMAP', join(DATA, 'basemap', 'edinburgh.pmtiles'))
const RD5 = need('FW_RD5', join(DATA, 'segments4', 'W5_N55.rd5'))

mkdirSync(OUT, { recursive: true })

const profile = KEEP
  ? join(tmpdir(), 'fw-drive-surface')
  : mkdtempSync(join(tmpdir(), 'fw-drive-surface-'))
mkdirSync(profile, { recursive: true })

const chrome = spawn(CHROME, [
  '--headless=new',
  '--remote-debugging-port=9224',
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
      const open = await (await fetch('http://127.0.0.1:9224/json/list')).json()
      for (const t of open) {
        if (t.type === 'page') await fetch(`http://127.0.0.1:9224/json/close/${t.id}`)
      }
      const res = await fetch('http://127.0.0.1:9224/json/new?about:blank', { method: 'PUT' })
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
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails
    console.error('  ✗ ' + (d.exception?.description ?? d.text))
  }
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

async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'))
  console.log(`  → ${name}.png`)
}

const click = (selector) =>
  evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return 'missing: ' + ${JSON.stringify(selector)}
    el.click()
    return 'ok'
  })()`)

const text = (selector) =>
  evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent?.trim() ?? null`)

const present = (selector) => evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)

const tapMap = async (x, y) => {
  const where = { x, y, button: 'left', clickCount: 1 }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...where })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...where })
}

const settleRouting = async (seconds = 40) => {
  for (let i = 0; i < seconds * 2; i++) {
    await sleep(500)
    if (!(await evaluate(`/working|finding/i.test(document.body.innerText)`))) return true
  }
  return false
}

await send('Page.enable')
await send('Runtime.enable')
await send('DOM.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true,
})

await send('Page.navigate', { url: BASE })
await sleep(1500)
await evaluate(`(async () => {
  for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister()
  for (const k of await caches.keys()) await caches.delete(k)
  localStorage.setItem('free-wheel.onboarded.v1', 'yes')
  localStorage.removeItem('free-wheel.plan.v2')
  localStorage.setItem('free-wheel.theme.v1', 'light')
  // The riding panel's page is remembered across launches, and \`--keep\` reuses the profile —
  // so without this a second run opens on whatever page the *first* run swiped to, and the
  // shot named for the graph quietly shows navigation instead.
  localStorage.removeItem('free-wheel.hud-page.v1')
  return 'cleared'
})()`)

await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16)
    window.cancelAnimationFrame = (id) => clearTimeout(id)
  `,
})

await send('Page.navigate', { url: BASE })
await sleep(3000)

const setFiles = async (selector, files) => {
  const { root } = await send('DOM.getDocument')
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector })
  if (!nodeId) throw new Error(`no ${selector} on screen`)
  await send('DOM.setFileInputFiles', { nodeId, files })
}

const settleImport = async (seconds) => {
  for (let i = 0; i < seconds; i++) {
    await sleep(1000)
    if (/imported|^$/i.test((await text('.maps-manual .meta')) ?? '')) return
  }
}

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
  await setFiles('input[accept=".pmtiles"]', [BASEMAP])
  await settleImport(150)
  await sleep(3000)
  await setFiles('input[accept=".rd5"]', [RD5])
  await settleImport(90)
  await sleep(2000)
  await click('.setup-close')
  await sleep(700)
  await click('.setup-close')
  await sleep(2500)
} else {
  console.log('already provisioned')
}

// The place index blocks the engine Worker while it runs, and a route asked for during it waits.
await sleep(4000)

// ── A route long enough to be made of more than one thing ────────────────────────────────

console.log('a route across town')
await tapMap(90, 250)
await sleep(900)
await tapMap(310, 640)
console.log('  routing: ' + (await settleRouting()))
await sleep(1500)
await shot('01-compared')

console.log('choosing one')
// The handle opens the sheet; `.route-card-main` is the part of the card that chooses. A
// click on `.route-card` itself only opens it, which is how this script first read a plan
// with `chosen: null` and reported the whole feature missing.
await click('.sheet-handle')
await sleep(900)
await click('.route-card-main')
await sleep(900)
await click('.sheet-handle')
await sleep(1200)
await shot('02-chosen')

/*
 * What the engine actually said.
 *
 * The screenshots answer "does it look right"; this answers "is there anything there at all",
 * which is the question a blank strip and a correctly-empty strip both look like.
 */
const described = await evaluate(`(() => {
  const raw = localStorage.getItem('free-wheel.plan.v2')
  const plan = JSON.parse(raw ?? '{}')
  const gpx = plan.gpx?.[plan.chosen]
  if (!gpx) return { error: 'no chosen gpx' }
  const ways = gpx.match(/<brouter:way>/g)?.length ?? 0
  const syms = [...gpx.matchAll(/<sym>([^<]*)<\\/sym>/g)].map((m) => m[1])
  const tally = {}
  for (const s of syms) tally[s.replace(/\\d+$/, '')] = (tally[s.replace(/\\d+$/, '')] ?? 0) + 1
  return {
    chosen: plan.chosen,
    kb: Math.round(gpx.length / 1024),
    ways,
    turns: syms.length,
    commands: tally,
    sampleTags: gpx.match(/<brouter:way>([^<]*)</)?.[1] ?? null,
  }
})()`)
console.log('  engine output: ' + JSON.stringify(described))

/** Whether the map is actually drawing the marks, and how many of each. */
const marks = await evaluate(`(() => {
  const el = document.querySelector('.maplibregl-map')
  const map = el && (el._map ?? window.__fwMap)
  if (!map) return 'no map handle'
  const src = map.getSource && map.getSource('route-ways')
  if (!src) return 'no route-ways source'
  const data = src._data ?? src.serialize?.().data
  const features = data?.features ?? []
  const tally = {}
  for (const f of features) tally[f.properties.mark] = (tally[f.properties.mark] ?? 0) + 1
  return { features: features.length, ...tally }
})()`)
console.log('  map marks: ' + JSON.stringify(marks))

console.log('the detail view')
await click('.sheet-handle')
await sleep(900)
await click('.route-card-details')
await sleep(900)
await shot('03-detail-top')

const strip = await evaluate(`(() => {
  const el = document.querySelector('.surface-strip')
  if (!el) return 'no strip'
  const rects = [...el.querySelectorAll('rect')]
  const fills = {}
  for (const r of rects) {
    const f = r.getAttribute('fill')
    if (f) fills[f] = (fills[f] ?? 0) + 1
  }
  const box = el.getBoundingClientRect()
  return { rects: rects.length, fills, width: Math.round(box.width), height: Math.round(box.height) }
})()`)
console.log('  strip: ' + JSON.stringify(strip))

const breakdown = await evaluate(`(() => {
  const root = document.querySelector('.breakdown')
  if (!root) return 'no breakdown'
  const rows = [...root.querySelectorAll('.breakdown-rows div')].map(
    (d) => d.querySelector('dt')?.textContent?.trim() + ' = ' + d.querySelector('dd')?.textContent?.trim(),
  )
  return { rows, network: root.querySelector('.breakdown-network')?.textContent?.trim() ?? null }
})()`)
console.log('  breakdown: ' + JSON.stringify(breakdown, null, 2))

// Scroll the drawer to the breakdown itself.
await evaluate(`(() => {
  const body = document.querySelector('.drawer-body')
  const target = document.querySelector('.breakdown')
  if (body && target) body.scrollTop = target.offsetTop - 80
  return 'scrolled'
})()`)
await sleep(600)
await shot('04-breakdown')

// ── Riding, stopped just short of a junction ─────────────────────────────────────────────

/*
 * The turn callout only exists while riding and only inside 400 m of a junction, so a shot of
 * it has to be *arranged*: parked at the start the strip says nothing, and a fix dropped at
 * random along the route lands between turns nine times out of ten.
 *
 * So the GPX is read for both the track and the junctions it marks, and the fix is walked up
 * to a few points short of one. `<sym>` sits on the track point the turn happens at, which is
 * the same indexing `gpx.ts` uses, so the two cannot disagree about which junction this is.
 */
console.log('riding up to a junction')
await send('Browser.grantPermissions', { permissions: ['geolocation'] })
await click('.drawer-back')
await sleep(700)
await click('.route-card-start')
await sleep(4000)

const ride = await evaluate(`(() => {
  const plan = JSON.parse(localStorage.getItem('free-wheel.plan.v2') ?? '{}')
  const gpx = plan.gpx?.[plan.chosen] ?? Object.values(plan.gpx ?? {})[0]
  if (!gpx) return { track: [], turns: [] }
  // BRouter writes lon before lat, which is the opposite of the order they are read in.
  const track = []
  const turns = []
  for (const m of gpx.matchAll(/<trkpt lon="([-\\d.]+)" lat="([-\\d.]+)">([\\s\\S]*?)<\\/trkpt>/g)) {
    const sym = /<sym>([^<]*)<\\/sym>/.exec(m[3])
    // The ones the app would speak: not straight on, not the finish, and not a slight turn.
    if (sym && /^(TL|TR|TSHL|TSHR|KL|KR|TU|RN[DL]B\\d+)$/.test(sym[1])) {
      turns.push({ index: track.length, command: sym[1] })
    }
    track.push([Number(m[2]), Number(m[1])])
  }
  return { track, turns }
})()`)
console.log(`  ${ride.track.length} track points, ${ride.turns.length} speakable junctions`)

const fixAt = async (index, speedMps, heading) => {
  const [latitude, longitude] = ride.track[Math.min(index, ride.track.length - 1)]
  await send('Emulation.setGeolocationOverride', {
    latitude,
    longitude,
    accuracy: 6,
    speed: speedMps,
    heading,
  })
}

// Far enough in that the figures are populated rather than sitting in their empty state, and
// a junction far enough along that there is road behind the rider for the progress bar.
const junction = ride.turns.find((t) => t.index > 40) ?? ride.turns.at(-1)
if (junction) {
  console.log(`  walking up to a ${junction.command} at point ${junction.index}`)
  // A few steps rather than a teleport, so `progress.ts` sees movement and `snapToRoute` keeps
  // its window hint rather than falling back to a global scan.
  for (const back of [26, 20, 15, 11, 8]) {
    await fixAt(Math.max(0, junction.index - back), 6.4, 90)
    await sleep(1100)
  }
  await sleep(2500)
}

/*
 * The callout on the layer that is actually showing.
 *
 * Both layers are in the DOM at all times — the folded one is only `visibility: hidden` — so a
 * bare `querySelector('.hud-callout')` returns the *expanded* panel's line whichever size the
 * panel is at. That read the graph page's climb while the strip beside it said "Left in 20 m".
 */
const calloutOf = () =>
  evaluate(`(() => {
    const layer = document.querySelector('.hud-layer[data-shown="yes"]')
    return layer?.querySelector('.hud-callout')?.textContent?.trim() ?? null
  })()`)
const hudExpanded = () =>
  evaluate(`document.querySelector('.hud-collapse')?.getAttribute('aria-expanded') === 'true'`)
const setHud = async (wanted) => {
  if ((await hudExpanded()) === wanted) return
  await click('.hud-collapse')
  await sleep(1400)
}

await setHud(false)
console.log('  strip says: ' + (await calloutOf()))
await shot('05-riding-strip')

await setHud(true)
await sleep(600)
console.log('  panel says: ' + (await calloutOf()))
await shot('06-riding-panel')

/*
 * Sideways, onto the navigation page.
 *
 * A real drag rather than writing the stored page and reloading, because the gesture is half
 * the feature: `hudAxis` has to call this a page change rather than a resize, and a reload
 * would end the ride and prove nothing about either.
 */
const swipeLeft = async (y, fromX, toX) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fromX, y })
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: fromX,
    y,
    button: 'left',
    clickCount: 1,
  })
  const steps = 8
  for (let i = 1; i <= steps; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(fromX + ((toX - fromX) * i) / steps),
      y,
      button: 'left',
      buttons: 1,
    })
    await sleep(16)
  }
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: toX,
    y,
    button: 'left',
    clickCount: 1,
  })
}

const panelMid = await evaluate(`(() => {
  const box = document.querySelector('.hud')?.getBoundingClientRect()
  return box ? Math.round(box.top + box.height / 2) : 150
})()`)
await swipeLeft(panelMid, 320, 70)
await sleep(900)
console.log(
  '  nav page: ' +
    (await evaluate(
      `document.querySelector('.hud-nav')?.textContent?.replace(/\\s+/g, ' ').trim() ?? 'not shown'`,
    )),
)
/* The track's offset against the panel's own width. They have to match, or a page peeks. */
console.log(
  '  track: ' +
    (await evaluate(`(() => {
      const panel = document.querySelector('.hud')
      const track = document.querySelector('.hud-track')
      const layer = document.querySelector('.hud-layer[data-layer="full"]')
      if (!panel || !track || !layer) return 'missing'
      const style = getComputedStyle(panel)
      return JSON.stringify({
        x: style.getPropertyValue('--hud-x').trim(),
        trackWidth: Math.round(track.getBoundingClientRect().width),
        layerWidth: Math.round(layer.getBoundingClientRect().width),
        offset: Math.round(track.getBoundingClientRect().left - layer.getBoundingClientRect().left),
        selected: String(document.getSelection() ?? '').slice(0, 20),
      })
    })()`)),
)
await shot('07-riding-navigation')

/*
 * The same swipe, started on the page dots.
 *
 * They are painted inside the chevron's hit strip — it spans the whole bottom edge — so the
 * one thing on screen saying "there is another page" is also the toggle. A swipe from there
 * used to read as a tap, because the tap test measured the vertical alone, and the panel
 * folded instead of paging. Both facts are checked: it went back a page, and it is still open.
 */
const dotsY = await evaluate(`(() => {
  const box = document.querySelector('.hud-dots')?.getBoundingClientRect()
  return box ? Math.round(box.top + box.height / 2) : null
})()`)
if (dotsY === null) {
  console.log('  no dots to swipe from')
} else {
  await swipeLeft(dotsY, 70, 320)
  await sleep(900)
  console.log(
    '  swipe from the dots: ' +
      (await evaluate(`(() => {
        const open = document.querySelector('.hud-collapse')?.getAttribute('aria-expanded')
        const x = getComputedStyle(document.querySelector('.hud')).getPropertyValue('--hud-x')
        // Both pages are always laid out, so presence in the DOM says nothing about which one
        // is up. \`aria-hidden\` is what the page actually sets, and what a reader follows.
        const shown = [...document.querySelectorAll('.hud-page')].findIndex(
          (p) => p.getAttribute('aria-hidden') === 'false',
        )
        return 'page ' + x.trim() + ', showing index ' + shown + ', panel open ' + open
      })()`)),
  )
  await shot('07b-swiped-from-the-dots')
}

// Back off the bike, or the dark pass below reloads into a ride in progress.
await evaluate(`(() => {
  const hold = [...document.querySelectorAll('button')].find((b) => /end ride/i.test(b.textContent))
  if (!hold) return 'no end button'
  for (const type of ['pointerdown', 'pointerup']) {
    hold.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1 }))
  }
  return 'pressed'
})()`)
await sleep(600)

// ── The dark theme, where the dash inverts ───────────────────────────────────────────────

console.log('dark chrome')
await evaluate(`localStorage.setItem('free-wheel.theme.v1', 'dark')`)
await send('Page.navigate', { url: BASE })
await sleep(4000)
await shot('08-dark-map')
await click('.sheet-handle')
await sleep(900)
await click('.route-card-details')
await sleep(1000)
await evaluate(`(() => {
  const body = document.querySelector('.drawer-body')
  const target = document.querySelector('.breakdown')
  if (body && target) body.scrollTop = target.offsetTop - 200
  return 'scrolled'
})()`)
await sleep(600)
await shot('09-dark-breakdown')

ws.close()
chrome.kill()
console.log('done')
