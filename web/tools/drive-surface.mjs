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

// ── The dark theme, where the dash inverts ───────────────────────────────────────────────

console.log('dark chrome')
await evaluate(`localStorage.setItem('free-wheel.theme.v1', 'dark')`)
await send('Page.navigate', { url: BASE })
await sleep(4000)
await shot('05-dark-map')
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
await shot('06-dark-breakdown')

ws.close()
chrome.kill()
console.log('done')
