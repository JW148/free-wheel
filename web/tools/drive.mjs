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

async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'))
  console.log(`  → ${name}.png`)
}

/**
 * Drags the plan sheet's handle to a fraction of the way open, and leaves the finger down.
 *
 * The sheet is one surface whose whole geometry is a `calc()` over `--sheet-p`, so the only
 * frame worth looking at is a half-open one: it is the frame that says whether the card is
 * becoming the sheet or being replaced by it. A `.click()` cannot produce it — that is an end
 * state — so this dispatches the pointer sequence the hook listens for.
 */
const dragHandle = (fraction) =>
  evaluate(`(() => {
    const handle = document.querySelector('.sheet-handle')
    const sheet = document.querySelector('.plan-sheet')
    if (!handle || !sheet) return 'missing handle'
    const style = getComputedStyle(document.querySelector('.sheet-layer'))
    const card = parseFloat(style.getPropertyValue('--sheet-card'))
    const open = parseFloat(style.getPropertyValue('--sheet-open'))
    const y = sheet.getBoundingClientRect().top + 12
    const at = (clientY, type) =>
      handle.dispatchEvent(
        new PointerEvent(type, { pointerId: 1, clientY, clientX: 195, bubbles: true }),
      )
    at(y, 'pointerdown')
    at(y - (open - card) * ${JSON.stringify(fraction)}, 'pointermove')
    return card + ' -> ' + open
  })()`)

const releaseHandle = () =>
  evaluate(`(() => {
    const handle = document.querySelector('.sheet-handle')
    handle?.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }))
    return 'ok'
  })()`)

/**
 * Types into a controlled React input.
 *
 * Setting `.value` directly does nothing: React's own value setter on the element shadows the
 * prototype's, so the synthetic `input` event carries the old value and the component re-renders
 * back over it. Going through the prototype descriptor is the standard way round that.
 */
const type = (selector, text) =>
  evaluate(`(() => {
    const field = document.querySelector(${JSON.stringify(selector)})
    if (!field) return 'missing: ' + ${JSON.stringify(selector)}
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(field, ${JSON.stringify(text)})
    field.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  })()`)

const click = (selector) =>
  evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return 'missing: ' + ${JSON.stringify(selector)}
    el.click()
    return 'ok'
  })()`)

/*
 * Anything the page threw, printed.
 *
 * A React error boundary-less tree renders nothing at all on a throw, and a screenshot of
 * nothing looks exactly like a screenshot of a map that has not loaded yet — which is a failure
 * this repo has already lost time to twice. `exceptionThrown` is the one signal that tells them
 * apart, and it costs one listener.
 */
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

/*
 * The search, against a real archive.
 *
 * `FW_ARCHIVE=/path/to/edinburgh.pmtiles` imports it through the app's own manual-import path,
 * which is the only way to see the feature actually work: the index is built in the engine
 * Worker out of OPFS, so a seeded fixture would exercise none of it. Without the variable the
 * run below still covers the empty states, which are the ones a rider meets first.
 */
if (process.env.FW_ARCHIVE) {
  console.log('importing an archive, and indexing it')
  await click('.plan-shortcuts button:nth-child(2)')
  await sleep(600)
  await click('.setup-menu-row:nth-child(1)')
  await sleep(900)
  await click('.maps-manual-toggle')
  await sleep(700)
  const { root } = await send('DOM.getDocument')
  const { nodeId } = await send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: 'input[accept=".pmtiles"]',
  })
  if (!nodeId) throw new Error('no .pmtiles file input on screen')
  await send('DOM.setFileInputFiles', { nodeId, files: [process.env.FW_ARCHIVE] })
  // The import writes 34 MB into OPFS and the index build then reads all of it back.
  for (let i = 0; i < 60; i++) {
    await sleep(1000)
    const state = await evaluate(`document.querySelector('.maps-manual .meta')?.textContent ?? ''`)
    if (/imported|^$/i.test(state)) break
  }
  await sleep(4000)
  await shot('12-imported')
  // Two Dones: the Maps screen's own, then the menu's. Setup is a stack, not a modal.
  await click('.setup-close')
  await sleep(900)
  await click('.setup-close')
  await sleep(2000)


  console.log('search, with something to find')
  await click('.map-search')
  await sleep(900)
  await type('.search-field', 'portobello')
  await sleep(900)
  await shot('12c-search-results')
  await type('.search-field', 'princes st')
  await sleep(900)
  await shot('12d-search-street')
  await evaluate(`document.querySelector('.search-body').scrollTop = 4000`)
  await sleep(300)
  await shot('12d2-search-scrolled')
  await evaluate(`document.querySelector('.search-body').scrollTop = 0`)
  await type('.search-field', 'Aberystwyth')
  await sleep(1500)
  await shot('12e-search-elsewhere')
  // Keep one, then look at the empty state: a saved place, and the arrow that rides to it.
  await type('.search-field', 'portobello beach')
  await sleep(700)
  await click('.place-item:first-child .place-action:last-child')
  await sleep(400)
  await type('.search-field', '')
  await sleep(600)
  await shot('12e2-saved-place')

  // Both ends, by name: the start, then the finish the screen stays open for.
  await type('.search-field', 'portobello')
  await sleep(700)
  await click('.place-row')
  await sleep(900)
  await shot('12f-start-chosen')
  await type('.search-field', 'cramond')
  await sleep(700)
  await click('.place-row')
  await sleep(2500)
  await shot('12g-planned')
}

/*
 * The search screen with nothing installed.
 *
 * What this exercises is the shape of the screen, the field stack, the rows above the results
 * and what it says when it has nothing: the states a rider meets on their first launch, which
 * are the ones most likely to be wrong.
 */
console.log('search')
await click('.map-search')
await sleep(700)
await shot('12a-search-empty')
await type('.search-field', 'Aberystwyth')
await sleep(1200)
await shot('12b-search-elsewhere')
await click('.screen-back')
await sleep(500)

console.log('Layers')
await click('[aria-label="Map layers, daylight and setup"]')
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

  // Half way up and still under the finger: the one frame that says whether the card is
  // becoming the sheet or being replaced by it.
  console.log('  ' + (await dragHandle(0.45)))
  await sleep(200)
  await shot('13b-half-dragged')
  // Released short of half way, so it settles back to the card rather than opening.
  await releaseHandle()
  await sleep(900)
  await shot('13c-settled-back')

  await click('.sheet-handle')
  await sleep(900)
  await shot('14-route-cards')
  await click('.route-more')
  await sleep(500)
  await shot('15-more-styles')
  await click('.route-more')
  await sleep(400)
  // Details only exists on the chosen card — there is nothing else it could describe.
  await click('.route-card-main')
  await sleep(600)
  await shot('15b-chosen')
  await click('.route-card-details')
  await sleep(700)
  await shot('16-route-detail')
  await evaluate(`document.querySelector('.sheet-full .drawer-body').scrollTop = 500`)
  await sleep(300)
  await shot('17-route-detail-scrolled')

  /*
   * The library, which needs something in it.
   *
   * Save then Clear: clearing the plan is also the only way back to the invite card, which is
   * where Saved is reachable from. The plan is seeded again afterwards for the riding shots.
   */
  console.log('Saved, with a route in it')
  await click('.route-actions button:nth-child(1)')
  await sleep(500)
  await click('.route-actions button:nth-child(4)')
  await sleep(700)
  await click('.plan-shortcuts button:nth-child(1)')
  await sleep(900)
  await shot('11b-saved-list')
  await click('.screen-back')
  await sleep(400)

  await evaluate(`localStorage.setItem('free-wheel.plan.v2', ${JSON.stringify(JSON.stringify(seed))})`)
  await send('Page.navigate', { url: BASE })
  await sleep(2500)
  await click('.setup-close')
  await sleep(700)

  /*
   * Riding.
   *
   * Needs a fix, so the permission is granted through CDP and the position overridden — the
   * route's own first coordinate, so the rider is on the line rather than 400 km off it and
   * staring at an "off route" banner.
   */
  await send('Browser.grantPermissions', { permissions: ['geolocation'] })
  await send('Emulation.setGeolocationOverride', {
    latitude: 51.5052,
    longitude: -0.0864,
    accuracy: 8,
  })
  // The re-seeded plan has nothing chosen, so riding is two taps away: pick a route, then
  // Start on the card it appeared on.
  await click('.sheet-handle')
  await sleep(800)
  await click('.route-card-main')
  await sleep(600)
  await click('.route-card-start')
  await sleep(3000)
  await shot('18-riding')
  await click('.hud-collapse')
  await sleep(700)
  await shot('19-riding-folded')

  console.log('dark chrome')
  await evaluate(`localStorage.setItem('free-wheel.theme.v1', 'dark')`)
  await send('Page.navigate', { url: BASE })
  await sleep(2500)
  await click('.setup-close')
  await sleep(700)
  await shot('20-dark-plan')
  await click('.sheet-handle')
  await sleep(900)
  await shot('21-dark-cards')
}

console.log(await evaluate(`document.body.innerText.slice(0, 300)`))

ws.close()
chrome.kill()
