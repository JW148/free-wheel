/**
 * Drives the built app through the stops flow, against a real basemap and real routing data.
 *
 * `drive.mjs` deliberately never routes — it seeds a stored plan from the parity corpus, which
 * is enough for every screen that only *draws* a route. Shaping is the one flow that cannot be
 * faked: the whole question is what happens between a tap and the line moving, so the engine
 * has to actually run. That costs an 86 MB import and about a minute, which is why this is its
 * own script rather than another `if` inside that one.
 *
 * It shares every trap `drive.mjs` works around, because they are properties of headless Chrome
 * and not of either script: the service worker serving the previous build, a hidden tab never
 * firing `requestAnimationFrame` (which MapLibre's style loader awaits, so the map silently
 * never loads and reports nothing), one OPFS sync handle per file so only one tab may be open,
 * and `--disable-gpu` killing WebGL2 outright.
 *
 *     npm run build && npm run preview &
 *     node tools/drive-stops.mjs [base-url] [out-dir]
 *
 * Needs two files, neither committed:
 *
 *     FW_BASEMAP   a PMTiles extract          data/basemap/edinburgh.pmtiles
 *     FW_RD5       the segment covering it    data/segments4/W5_N55.rd5
 *
 * `--keep` reuses the browser profile, so the import happens once across runs.
 */

import { mkdirSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const BASE = process.argv.find((a) => a.startsWith('http')) ?? 'http://127.0.0.1:4173'
const OUT = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 'shots/stops'
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
  ? join(tmpdir(), 'fw-drive-stops')
  : mkdtempSync(join(tmpdir(), 'fw-drive-stops-'))
mkdirSync(profile, { recursive: true })

const chrome = spawn(CHROME, [
  '--headless=new',
  '--remote-debugging-port=9223',
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
      const open = await (await fetch('http://127.0.0.1:9223/json/list')).json()
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

const countOf = (selector) => evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`)

/**
 * A tap on the map, at a point on the screen.
 *
 * Through `Input.dispatchMouseEvent` rather than a synthetic `MouseEvent`: MapLibre reads a
 * click against the position of the press before it, and a lone click event has no press to be
 * within tolerance of.
 */
const tapMap = async (x, y) => {
  const where = { x, y, button: 'left', clickCount: 1 }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...where })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...where })
}

/** Waits for the engine to stop working, so a shot is of an answer rather than a spinner. */
const settleRouting = async (seconds = 40) => {
  for (let i = 0; i < seconds * 2; i++) {
    await sleep(500)
    if (!(await evaluate(`/working|finding/i.test(document.body.innerText)`))) return true
  }
  return false
}

/** The plan as the app has stored it — the one place the pins and the line have to agree. */
const stored = async () => {
  const raw = await evaluate(`localStorage.getItem('free-wheel.plan.v2')`)
  const plan = JSON.parse(raw ?? '{}')
  return {
    points: (plan.waypoints ?? []).length,
    routes: Object.keys(plan.gpx ?? {}),
    chosen: plan.chosen,
  }
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
  // All of this is set once, here, rather than in the per-document script below — which runs on
  // every navigation, including the reloads this script does on purpose. Written there, the
  // theme reset would undo the dark pass a line after setting it, and clearing the plan would
  // wipe the shaped route whose dark rendering is the whole point of that pass.
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

// ── A phone with a map and road data on it ───────────────────────────────────────────────

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

// The gate is up exactly when this phone has nothing to ride on, which is the signal that the
// `--keep` profile has not been provisioned yet.
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

// ── Two taps: a journey, and three ways to ride it ───────────────────────────────────────

console.log('two points')
await tapMap(120, 330)
await sleep(900)
await shot('01-one-point')
await tapMap(270, 520)
console.log('  routing: ' + (await settleRouting()))
await sleep(1500)
await shot('02-compared')
console.log('  ' + JSON.stringify(await stored()))

console.log('choosing one')
await click('.sheet-handle')
await sleep(900)
await shot('03-cards')
await click('.route-card-main')
await sleep(900)
await click('.sheet-handle')
await sleep(900)
await shot('04-chosen')

// ── The third tap: the one that used to do nothing ───────────────────────────────────────

/*
 * The whole feature, in one gesture. Before this the pin appeared and the line went on
 * describing the two-point journey underneath it — so the thing to check is not that a marker
 * was added but that the *stored route* changed and the pin count went to three.
 */
console.log('a stop, beside the line')
const beforeStop = await stored()
await tapMap(205, 400)
await sleep(400)
// Caught mid-search: the line that is about to be replaced, dimmed rather than gone.
await shot('05-stale-while-routing')
console.log('  routing: ' + (await settleRouting()))
await sleep(1500)
await shot('06-routed-through-the-stop')
const afterStop = await stored()
console.log('  ' + JSON.stringify(afterStop))
console.log(
  `  points ${beforeStop.points} -> ${afterStop.points}, ` +
    `routes ${beforeStop.routes.length} -> ${afterStop.routes.length}, ` +
    `chosen ${beforeStop.chosen} -> ${afterStop.chosen}`,
)

console.log('the sheet, while shaping')
await click('.sheet-handle')
await sleep(900)
await shot('07-shaping-sheet')
console.log('  heading: ' + (await text('.drawer-title')))
console.log('  cards: ' + (await countOf('.route-card')))
console.log('  points listed: ' + (await countOf('.sheet-full .plan-point-label')))
console.log('  roles: ' + JSON.stringify(await evaluate(
  `[...document.querySelectorAll('.sheet-full .plan-point-badge')].map((e) => e.textContent)`,
)))

// ── Closing the loop ─────────────────────────────────────────────────────────────────────

console.log('make a loop')
await evaluate(`[...document.querySelectorAll('.sheet-actions button')]
  .find((b) => b.textContent.includes('loop'))?.click()`)
console.log('  routing: ' + (await settleRouting()))
await sleep(2000)
await shot('08-loop')
const loop = await stored()
console.log('  ' + JSON.stringify(loop))
console.log('  loop button now: ' + (await evaluate(
  `[...document.querySelectorAll('.sheet-actions button')].find((b) => b.textContent.includes('loop'))?.disabled`,
)))
await click('.sheet-handle')
await sleep(800)

// ── A stop with a name ───────────────────────────────────────────────────────────────────

console.log('add a stop, by name')
await click('.map-search')
await sleep(1200)
await shot('09-search-with-add-a-stop')
console.log('  row: ' + (await text('.search-add')))
await click('.search-add')
await sleep(900)
await shot('10-stop-field-open')
console.log('  placeholder: ' + (await evaluate(
  `document.querySelector('.search-row[data-active="yes"] .search-field')?.placeholder`,
)))

// ── Taking one back out ──────────────────────────────────────────────────────────────────

await click('.screen-back')
await sleep(900)
console.log('removing a stop')
await click('.sheet-handle')
await sleep(900)
// The rows are a flat grid rather than list items, so the × belongs to the badge two cells
// along: badge, label, button.
await evaluate(`(() => {
  const badge = document.querySelector('.sheet-full .plan-point-badge[data-role="via"]')
  const remove = badge?.nextElementSibling?.nextElementSibling
  if (!remove) return 'no stop to remove'
  remove.click()
  return 'ok'
})()`)
console.log('  routing: ' + (await settleRouting()))
await sleep(1500)
await shot('11-stop-removed')
console.log('  ' + JSON.stringify(await stored()))

// ── The same thing on the night map ──────────────────────────────────────────────────────

console.log('dark chrome')
await evaluate(`localStorage.setItem('free-wheel.theme.v1', 'dark')`)
await send('Page.navigate', { url: BASE })
await sleep(4000)
await shot('12-dark-shaped')
await click('.sheet-handle')
await sleep(1000)
await shot('13-dark-sheet')

ws.close()
chrome.kill()
