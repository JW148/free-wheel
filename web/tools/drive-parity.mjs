/**
 * Checks one corpus route through the *running app* and compares it to the JVM, byte for byte.
 *
 * The check the unit tests cannot make. `jvmRoutes` records what the JVM produced; this asks
 * the WasmGC engine for the same waypoints out of OPFS and compares the GPX. It is worth
 * running deliberately after a change to the output format, because mode 9 writes numbers the
 * plain mode never did — `VoiceHint.formatGeometry` casts floats to ints — and a float cast is
 * exactly the kind of thing a translation gets subtly wrong.
 *
 * ## Why one route and not the whole corpus
 *
 * The Diagnostics panel replays all eighteen, and it is the right tool on a phone. Here it
 * needs `W5_N50` and `E0_N50` in OPFS — 215 MB through the file picker, which took half an
 * hour and is long enough that nobody will run it. `edinburgh-short` exists in the corpus
 * precisely so there is one case inside `W5_N55`, the 26 MB tile every driver script already
 * imports. One route that actually gets checked beats eighteen that do not.
 *
 * ## What this proves, and what it does not
 *
 * It runs in headless Chrome, so it compares **V8** against HotSpot. The claim in the handoff
 * is that **JSC** matches HotSpot bit for bit, and only a real iPhone settles that — the
 * Diagnostics panel is there for exactly that run.
 *
 * ## How the exact waypoints get in
 *
 * A tap cannot place a point on a given coordinate, so the plan is seeded — **reversed** — and
 * the app's own Reverse button is pressed. That routes it, in order, through the same
 * `toFixed(6)` path a rider's tap would take, so the engine is asked the same question the JVM
 * was asked rather than a similar one.
 *
 *     cd engine && ./gradlew jvmRoutes          # writes build/reference-gpx/*.gpx
 *     cd ../web && npm run build && npx vite preview --port 4173 &
 *     node tools/drive-parity.mjs [base-url] [--keep]
 *
 *     FW_RD5   the tile the case sits in       data/segments4/W5_N55.rd5
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const BASE = process.argv.find((a) => a.startsWith('http')) ?? 'http://127.0.0.1:4173'
const KEEP = process.argv.includes('--keep')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const ROOT = resolve(process.cwd(), '..')

/** The case to check, and the tile it needs. Both are corpus facts, not choices made here. */
const CASE_ID = 'edinburgh-short'
const MODE = 9

const need = (name, fallback) => {
  const path = process.env[name] ?? fallback
  if (!existsSync(path)) throw new Error(`${name} not found at ${path}`)
  return path
}
const RD5 = need('FW_RD5', join(ROOT, 'data', 'segments4', 'W5_N55.rd5'))
const REFERENCE = join(ROOT, 'engine', 'build', 'reference-gpx', `${CASE_ID}-ti${MODE}.gpx`)
if (!existsSync(REFERENCE)) {
  throw new Error(`no ${REFERENCE} — run \`cd engine && ./gradlew jvmRoutes\` first`)
}

const corpus = JSON.parse(readFileSync(join('public', 'engine', 'jvm-routes.json'), 'utf8'))
const expected = corpus.routes.find((r) => r.id === `${CASE_ID}-ti${MODE}`)
if (!expected) throw new Error(`no ${CASE_ID}-ti${MODE} in jvm-routes.json`)

const referenceBytes = readFileSync(REFERENCE)
const expectedSha = createHash('sha256').update(referenceBytes).digest('hex')

// `lon,lat|lon,lat` out of the corpus, so the waypoints cannot drift from the case they claim
// to check. Reversed, because Reverse is what makes the app route them.
const points = expected.lonLats
  .split('|')
  .map((pair) => pair.split(',').map(Number))
  .map(([lon, lat]) => ({ lon, lat }))
const seeded = {
  v: 4,
  waypoints: [...points].reverse(),
  selection: [expected.profile],
  chosen: null,
}

const profile = KEEP
  ? join(tmpdir(), 'fw-drive-surface')
  : mkdtempSync(join(tmpdir(), 'fw-drive-parity-'))
mkdirSync(profile, { recursive: true })

const chrome = spawn(CHROME, [
  '--headless=new',
  '--remote-debugging-port=9226',
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
      const open = await (await fetch('http://127.0.0.1:9226/json/list')).json()
      for (const t of open) {
        if (t.type === 'page') await fetch(`http://127.0.0.1:9226/json/close/${t.id}`)
      }
      const res = await fetch('http://127.0.0.1:9226/json/new?about:blank', { method: 'PUT' })
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

const click = (selector) =>
  evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return 'missing: ' + ${JSON.stringify(selector)}
    el.click()
    return 'ok'
  })()`)

const clickText = (selector, text) =>
  evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((e) => e.textContent.trim().toLowerCase() === ${JSON.stringify(text.toLowerCase())})
    if (!el) return 'no ' + ${JSON.stringify(selector)} + ' labelled ' + ${JSON.stringify(text)}
    el.click()
    return 'ok'
  })()`)

const present = (selector) => evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)

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

// The maps gate is up exactly when this phone has nothing to ride on, so it is also the signal
// that a `--keep` profile has not been provisioned yet.
if (await present('.setup-close')) {
  console.log(`importing ${RD5.split('/').pop()} — once per profile`)
  await click('.setup-close')
  await sleep(600)
  await click('.plan-shortcuts button:nth-child(2)')
  await sleep(600)
  await click('.setup-menu-row:nth-child(1)')
  await sleep(900)
  await click('.maps-manual-toggle')
  await sleep(700)
  await setFiles('input[accept=".rd5"]', [RD5])
  for (let i = 0; i < 180; i++) {
    await sleep(1000)
    const meta = await evaluate(`document.querySelector('.maps-manual .meta')?.textContent ?? ''`)
    if (/imported/i.test(meta)) break
  }
  await sleep(2000)
  await click('.setup-close')
  await sleep(700)
  await click('.setup-close')
  await sleep(2000)
} else {
  console.log('already provisioned')
}

console.log(`seeding ${CASE_ID} reversed, then pressing Reverse`)
await evaluate(
  `localStorage.setItem('free-wheel.plan.v2', ${JSON.stringify(JSON.stringify(seeded))})`,
)
await send('Page.navigate', { url: BASE })
await sleep(4000)

await click('.sheet-handle')
await sleep(900)
console.log('  ' + (await clickText('.sheet-actions button', 'Reverse')))

for (let i = 0; i < 120; i++) {
  await sleep(500)
  if (!(await evaluate(`/working|finding/i.test(document.body.innerText)`))) break
}
await sleep(1500)

const actual = await evaluate(`(async () => {
  const plan = JSON.parse(localStorage.getItem('free-wheel.plan.v2') ?? '{}')
  const gpx = plan.gpx?.[${JSON.stringify(expected.profile)}]
  if (!gpx) return { error: 'no gpx for ' + ${JSON.stringify(expected.profile)} }
  const bytes = new TextEncoder().encode(gpx)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return {
    lonLats: (plan.waypoints ?? [])
      .map((w) => w.lon.toFixed(6) + ',' + w.lat.toFixed(6))
      .join('|'),
    length: bytes.length,
    sha256: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''),
  }
})()`)

ws.close()
chrome.kill()

if (actual.error) {
  console.error(`FAILED — ${actual.error}`)
  process.exit(1)
}

const sameQuestion = actual.lonLats === expected.lonLats
const sameLength = actual.length === expected.gpxLength
const sameBytes = actual.sha256 === expectedSha

console.log('')
console.log(`case      ${CASE_ID}, mode ${MODE}, profile ${expected.profile}`)
console.log(`waypoints ${sameQuestion ? 'same' : 'DIFFERENT'}`)
console.log(`          jvm  ${expected.lonLats}`)
console.log(`          wasm ${actual.lonLats}`)
console.log(`length    jvm ${expected.gpxLength}  wasm ${actual.length}  ${sameLength ? 'same' : 'DIFFERENT'}`)
console.log(`sha256    jvm ${expectedSha.slice(0, 16)}…  wasm ${actual.sha256.slice(0, 16)}…`)
console.log('')

if (sameQuestion && sameLength && sameBytes) {
  console.log('byte-identical ✓')
} else {
  console.error('MISMATCH — the Wasm engine and the JVM disagree')
  process.exit(1)
}
