#!/usr/bin/env node
/**
 * Serves web/dist over the LAN, exactly like `vite preview`, plus one extra route:
 *
 *   POST /spike-report   →  writes the body to docs/spike-runs/<timestamp>.md
 *
 * Why this exists: every acceptance criterion that matters is measured on a physical
 * iPhone, and the plan has us re-measuring repeatedly (Spike 2's durability protocol,
 * Spike 3's 10/50/100/150 km timings). Retyping results off a phone screen is both
 * tedious and a good way to record a mismatch as a match. This lets the device write
 * its own results where they can be read directly.
 *
 * Deliberately dependency-free and LAN-only. Not an internet-facing server: it accepts
 * unauthenticated writes to a fixed directory, which is fine on a home network for the
 * length of a test run, and not fine anywhere else.
 *
 * Usage:  node tools/report-server.mjs [port]
 */

import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { readFileSync, existsSync } from 'node:fs'
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join, extname, normalize, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { networkInterfaces } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = join(HERE, '..', 'dist')
const RUNS = join(HERE, '..', '..', 'docs', 'spike-runs')
// Segment tiles are served from data/ rather than copied into public/: W5_N50.rd5 alone is
// 137 MB, so duplicating it into the bundle would waste disk and slow every build.
const SEGMENTS = join(HERE, '..', '..', 'data', 'segments4')
const BASEMAPS = join(HERE, '..', '..', 'data', 'basemap')
const CERTS = join(HERE, '..', 'certs')

const args = process.argv.slice(2)
// HTTPS is not a nicety here: OPFS is [SecureContext], so `navigator.storage` does not exist
// on a plain-HTTP origin and Phase 1 cannot run on a phone without it.
const useHttps = args.includes('--https')
const PORT = Number(args.find((a) => /^\d+$/.test(a)) ?? 4173)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  // Must be exactly this, or WebAssembly.compileStreaming refuses the response.
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  // MapLibre glyph ranges. Served with the wrong type they decode anyway, but being explicit
  // keeps a mismatch visible.
  '.pbf': 'application/x-protobuf',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
}

/** Reads the whole request body as UTF-8, with a cap so a stray client can't exhaust memory. */
async function readBody(req, limitBytes = 2_000_000) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limitBytes) throw new Error('body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** `spike-2026-07-26T18-42-05.md` — sorts chronologically, safe on every filesystem. */
function timestampedName() {
  return `spike-${new Date().toISOString().replace(/:/g, '-').replace(/\..+$/, '')}.md`
}

async function handleReport(req, res) {
  const body = await readBody(req)
  if (!body.trim()) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'empty report' }))
    return
  }

  await mkdir(RUNS, { recursive: true })
  const name = timestampedName()
  const ua = req.headers['user-agent'] ?? 'unknown'
  await writeFile(join(RUNS, name), `<!-- User-Agent: ${ua} -->\n\n${body}\n`, 'utf8')

  console.log(`\n  ✓ report received → docs/spike-runs/${name}`)
  console.log(`    from: ${ua}\n`)

  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ saved: `docs/spike-runs/${name}` }))
}

/**
 * Streams a .rd5 tile out of data/segments4.
 *
 * **The app does not use this.** Tiles enter the app by user import only; nothing in the
 * client fetches a segment over HTTP. This route exists purely as a development convenience:
 * it puts the local fixture tile within reach of a test device (download it in Safari, then
 * import it) without re-fetching 137 MB from brouter.de for every test run.
 *
 * Streamed, not read into a Buffer — these files are hundreds of megabytes.
 */
async function serveSegment(req, res) {
  // basename() alone is enough containment here — no path can escape the directory.
  const name = basename(decodeURIComponent(new URL(req.url, 'http://localhost').pathname))
  const basemap = name.endsWith('.pmtiles')
  if (!name.endsWith('.rd5') && !basemap) {
    res.writeHead(404).end('not found')
    return
  }

  const file = join(basemap ? BASEMAPS : SEGMENTS, name)
  let info
  try {
    info = await stat(file)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end(`no such segment: ${name}. Download it into data/segments4/ — see README.`)
    return
  }

  // Range + ETag are not optional niceties here: the tile downloader resumes with
  // `Range` + `If-Range`, and without them that path could never be exercised locally.
  // brouter.de supports both, so matching its behaviour keeps dev honest.
  const etag = `"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`
  const base = {
    'content-type': 'application/octet-stream',
    'accept-ranges': 'bytes',
    etag,
    'last-modified': info.mtime.toUTCString(),
    'cache-control': 'no-cache',
  }

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
  // If-Range: serve the full body instead of a partial one when the validator no longer
  // matches, so a resume can never splice bytes from two different builds of a tile.
  const ifRange = req.headers['if-range']
  const validatorMatches = !ifRange || ifRange === etag

  if (range && validatorMatches) {
    const start = range[1] ? Number(range[1]) : 0
    const end = range[2] ? Number(range[2]) : info.size - 1
    if (start >= info.size || end < start) {
      res.writeHead(416, { ...base, 'content-range': `bytes */${info.size}` })
      res.end()
      return
    }
    res.writeHead(206, {
      ...base,
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${info.size}`,
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(file, { start, end }).pipe(res)
    return
  }

  res.writeHead(200, { ...base, 'content-length': String(info.size) })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(file).pipe(res)
}

/**
 * Serves the local CA so the phone can install it.
 *
 * `application/x-x509-ca-cert` is what makes iOS offer to install a configuration profile
 * rather than download an opaque file.
 */
function serveCaCert(res) {
  const ca = join(CERTS, 'ca.crt')
  if (!existsSync(ca)) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('no CA yet — run tools/make-certs.sh')
    return
  }
  res.writeHead(200, {
    'content-type': 'application/x-x509-ca-cert',
    'content-disposition': 'attachment; filename="free-wheel-ca.crt"',
  })
  res.end(readFileSync(ca))
}

async function serveStatic(req, res) {
  // normalize() collapses `..` before it can escape dist.
  const rawPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
  const relative = normalize(rawPath).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '')
  const candidate = join(DIST, relative || 'index.html')

  if (!candidate.startsWith(DIST)) {
    res.writeHead(403).end('forbidden')
    return
  }

  // A missing build artefact must 404, not fall through to index.html. Serving a hashed
  // asset path as HTML with a 200 is how a missing MapLibre worker chunk masqueraded as a
  // map that simply would not render — see src/map/maplibreWorker.ts. The SPA fallback is
  // for routes, and /assets/ never contains one.
  const isBuildArtefact =
    /^assets\//.test(relative) || /\.(js|mjs|css|wasm|map|pbf|png)$/.test(relative)
  const targets = isBuildArtefact ? [candidate] : [candidate, join(DIST, 'index.html')]

  for (const target of targets) {
    try {
      const file = await readFile(target)
      res.writeHead(200, {
        'content-type': MIME[extname(target)] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
      })
      res.end(file)
      return
    } catch {
      // Try the SPA fallback next.
    }
  }

  res.writeHead(404).end('not found')
}

const handler = async (req, res) => {
  // The phone posts cross-origin in some setups (tunnel, different host header).
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-headers', 'content-type')

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end()
    } else if (req.method === 'POST' && req.url.startsWith('/spike-report')) {
      await handleReport(req, res)
    } else if (req.url.startsWith('/ca.crt')) {
      serveCaCert(res)
    } else if (req.url.startsWith('/segments4/') || req.url.startsWith('/basemap/')) {
      await serveSegment(req, res)
    } else {
      await serveStatic(req, res)
    }
  } catch (error) {
    console.error(error)
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: String(error?.message ?? error) }))
  }
}

let server
if (useHttps) {
  const key = join(CERTS, 'server.key')
  const cert = join(CERTS, 'server.crt')
  if (!existsSync(key) || !existsSync(cert)) {
    console.error('\n  --https given but no certificate found.\n  Run: ./tools/make-certs.sh\n')
    process.exit(1)
  }
  server = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, handler)
} else {
  server = createHttpServer(handler)
}

server.listen(PORT, '0.0.0.0', () => {
  const scheme = useHttps ? 'https' : 'http'
  console.log(`\n  free-wheel spike server (${scheme})`)
  if (!useHttps) {
    console.log('  NOTE: OPFS needs a secure context — Phase 1 will not run over http.')
    console.log('        Use --https (see tools/make-certs.sh).')
  }
  console.log(`  serving   ${DIST}`)
  console.log(`  reports → ${RUNS}\n`)
  console.log(`  Local:    ${scheme}://localhost:${PORT}/`)
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        console.log(`  Network:  ${scheme}://${address.address}:${PORT}/`)
      }
    }
  }
  console.log('')
})
