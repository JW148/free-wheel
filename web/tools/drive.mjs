/**
 * Drives the built app in headless Chrome over CDP, at a true phone width.
 *
 * Not a test — a way to *look* at the thing. `vitest` covers the pure logic; this is for the
 * questions only a rendered screen answers: whether a white card separates from a pale map,
 * whether a 28px title fits beside a back button at 390px, whether the sheet is where the
 * design put it.
 *
 * The four traps this works around are recorded in the repo's notes and each of them cost a
 * pass: the service worker serving the previous build, a headless tab never firing
 * `requestAnimationFrame` (which MapLibre's style loader awaits, so the map silently never
 * loads), OPFS allowing one sync handle per file so a second tab poisons the first, and
 * `--disable-gpu` killing WebGL2 outright.
 *
 *     node tools/drive.mjs <base-url> <out-dir>
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:4173'
const OUT = process.argv[3] ?? 'shots'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

mkdirSync(OUT, { recursive: true })

const profile = mkdtempSync(join(tmpdir(), 'fw-drive-'))
const chrome = spawn(CHROME, [
  '--headless=new',
  '--remote-debugging-port=9222',
  `--user-data-dir=${profile}`,
  // Chrome floors a headless *window* at ~500 CSS px; the real 390 comes from
  // Emulation.setDeviceMetricsOverride below. This only has to be big enough not to clip it.
  '--window-size=500,900',
  // `--disable-gpu` would leave MapLibre rendering nothing but its "no WebGL2" message.
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-first-run',
])
chrome.stderr.on('data', () => {})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      // One tab at a time: OPFS allows one sync access handle per file, so a second tab
      // collides with the first and the app reports it cannot reach storage.
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
  const waiter = pending.get(msg.id)
  if (!waiter) return
  pending.delete(msg.id)
  msg.error ? waiter.reject(new Error(JSON.stringify(msg.error))) : waiter.resolve(msg.result)
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

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true,
})

// Trap 1: the app precaches, so a rebuild changes nothing on screen until the previous service
// worker is gone. `Network.setCacheDisabled` does not help — the SW is not the HTTP cache.
await send('Page.navigate', { url: BASE })
await sleep(1500)
await evaluate(`(async () => {
  for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister()
  for (const k of await caches.keys()) await caches.delete(k)
  return 'cleared'
})()`)

// Trap 2: a headless tab never fires rAF, and MapLibre's style loader awaits one — without
// this the map never loads and reports no error at all. `cancelAnimationFrame` has to be
// shimmed too, or teardown throws from inside MapLibre.
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16)
    window.cancelAnimationFrame = (id) => clearTimeout(id)
  `,
})

await send('Page.navigate', { url: BASE })
await sleep(2500)

console.log('walkthrough')
await shot('01-onboarding')
for (const step of [2, 3, 4, 5, 6]) {
  await click('.onboarding-foot .primary')
  await sleep(500)
  await shot(`0${step}-onboarding-${step}`)
}
// The sixth card's button is the permission ask, which also finishes the walkthrough.
await click('.onboarding-foot .primary')
await sleep(1500)

console.log('the gate, and Setup')
await shot('07-maps-gate')
await click('.setup-close')
await sleep(600)
await shot('07b-plan-card')

console.log('Setup')
await click('.plan-shortcuts button:nth-child(2)')
await sleep(600)
await shot('08-setup-menu')
await click('.setup-menu-row:nth-child(2)')
await sleep(600)
await shot('09-rider')
await evaluate(`document.querySelector('.screen-body').scrollTop = 420`)
await sleep(300)
await shot('10-rider-scrolled')
await click('.screen-back')
await sleep(400)
await click('.setup-close')
await sleep(500)

console.log('Saved')
await click('.plan-shortcuts button:nth-child(1)')
await sleep(700)
await shot('11-saved')
await click('.screen-back')
await sleep(500)

console.log('Layers')
await click('[aria-label="Map layers and daylight"]')
await sleep(700)
await shot('12-layers')
await evaluate(`document.querySelector('.drawer-overlay')?.click()`)
await sleep(500)

/*
 * The route cards, without an engine.
 *
 * This profile has no region downloaded, so nothing can actually be routed — but the sheet is
 * drawn from parsed GPX, and the parity corpus is real BRouter output. Seeding the stored plan
 * with three copies of it is enough to see the thing that matters here: three cards, their
 * figures, the chosen state, and the detail behind it.
 */
if (process.env.FW_SEED) {
  const seed = JSON.parse(process.env.FW_SEED)
  await evaluate(`localStorage.setItem('free-wheel.plan.v2', ${JSON.stringify(JSON.stringify(seed))})`)
  await send('Page.navigate', { url: BASE })
  await sleep(2500)
  // Nothing is downloaded in this profile, so the first-run gate is up again on reload. It is
  // not the walkthrough — that is remembered — it is "this phone has nothing to ride on".
  await click('.setup-close')
  await sleep(700)
  await shot('13-routed-card')
  await click('.card-handle')
  await sleep(700)
  await shot('14-route-cards')
  await click('.route-more')
  await sleep(500)
  await shot('15-more-styles')
  await click('.route-more')
  await sleep(400)
  // Details only exists on the chosen card — there is nothing else it could describe.
  await click('.route-card')
  await sleep(600)
  await shot('15b-chosen')
  await click('.route-card-details')
  await sleep(700)
  await shot('16-route-detail')
  await evaluate(`document.querySelector('.drawer-body').scrollTop = 500`)
  await sleep(300)
  await shot('17-route-detail-scrolled')
  await sleep(1500)
  await shot('16b-detail-settled')
  // Is the smear above the sheet real, or SwiftShader mis-sampling a backdrop filter?
  await evaluate(`(() => {
    const s = document.createElement('style')
    s.textContent = '.drawer { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; background: #fff !important }'
    document.head.appendChild(s)
  })()`)
  await sleep(600)
  await shot('16c-detail-no-blur')
  console.log(await evaluate(`JSON.stringify([[10,45],[195,45],[195,30]].map(([x,y]) => {
    const el = document.elementFromPoint(x, y)
    return el ? el.className + '|' + (el.textContent || '').slice(0, 30) : 'none'
  }))`))
}

console.log(await evaluate(`document.body.innerText.slice(0, 300)`))

ws.close()
chrome.kill()
