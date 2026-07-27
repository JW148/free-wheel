#!/usr/bin/env node
/**
 * Downloads the glyph and sprite assets the basemap style needs into `web/public/`.
 *
 * PMTiles archives contain geometry and nothing else. MapLibre fetches glyphs (SDF font
 * atlases) and sprites (icon sheets) as separate HTTP requests, so a style with text or icon
 * layers is **online-only** unless those files are self-hosted and precached. That is the
 * classic offline-MapLibre trap, and it shows up as a map that renders perfectly on the desk
 * and loses every label in airplane mode.
 *
 * The output is committed rather than gitignored, deliberately: an offline-first app should
 * not need a network round trip to produce a map with labels in it. This script exists to
 * refresh those files, not as a build step.
 *
 * Usage:  node tools/fetch-map-assets.mjs [--force]
 */

import { mkdir, writeFile, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PUBLIC = join(HERE, '..', 'public')

const UPSTREAM = 'https://raw.githubusercontent.com/protomaps/basemaps-assets/main'

/**
 * Weights the style actually asks for. Every additional stack is a full set of ranges, so
 * this list is the main lever on the offline payload — keep it to what is used.
 */
const FONTSTACKS = ['Noto Sans Regular', 'Noto Sans Medium']

/**
 * Unicode ranges to ship, out of the 256 the upstream repo publishes per stack.
 *
 * A range that is not shipped is not a crash: MapLibre logs a glyph error and draws the
 * label without those characters. But it *is* invisible until someone routes somewhere the
 * charset does not cover, so the choice is European coverage plus punctuation rather than
 * Latin-1 alone.
 *
 * - `0-255`      Basic Latin, Latin-1 Supplement — English, French, German, Spanish
 * - `256-511`    Latin Extended-A — Polish, Czech, Hungarian, Welsh, Turkish
 * - `512-767`    Latin Extended-B, IPA
 * - `768-1023`   Combining diacritics, Greek
 * - `1024-1279`  Cyrillic
 * - `8192-8447`  General Punctuation — en/em dashes and curly apostrophes, which turn up in
 *                ordinary place names and are easy to forget
 */
const RANGES = ['0-255', '256-511', '512-767', '768-1023', '1024-1279', '8192-8447']

/**
 * The `light` sprite sheet, at 1× and 2×. MapLibre picks by devicePixelRatio and a phone will
 * always want @2x, so shipping only one guarantees missing icons on exactly the target device.
 */
const SPRITES = ['light.json', 'light.png', 'light@2x.json', 'light@2x.png']

const force = process.argv.includes('--force')

async function download(url, destination) {
  if (!force) {
    try {
      const existing = await stat(destination)
      return { skipped: true, bytes: existing.size }
    } catch {
      // Not there yet — fall through and fetch it.
    }
  }
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} — ${url}`)
  const body = Buffer.from(await response.arrayBuffer())
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, body)
  return { skipped: false, bytes: body.byteLength }
}

const jobs = [
  // The SIL Open Font License requires the licence text to travel with the fonts.
  { url: `${UPSTREAM}/fonts/OFL.txt`, to: join(PUBLIC, 'fonts', 'OFL.txt') },
  ...FONTSTACKS.flatMap((stack) =>
    RANGES.map((range) => ({
      url: `${UPSTREAM}/fonts/${encodeURIComponent(stack)}/${range}.pbf`,
      to: join(PUBLIC, 'fonts', stack, `${range}.pbf`),
    })),
  ),
  ...SPRITES.map((name) => ({
    url: `${UPSTREAM}/sprites/v4/${name}`,
    to: join(PUBLIC, 'sprites', name),
  })),
]

let total = 0
let fetched = 0
for (const { url, to } of jobs) {
  const { skipped, bytes } = await download(url, to)
  total += bytes
  if (!skipped) fetched += 1
  console.log(`${skipped ? 'have' : 'get '}  ${(bytes / 1024).toFixed(0).padStart(5)} kB  ${to.slice(PUBLIC.length + 1)}`)
}

console.log(
  `\n${jobs.length} files, ${(total / 1e6).toFixed(2)} MB total (${fetched} downloaded).` +
    (fetched === 0 ? ' Nothing changed — pass --force to refetch.' : ''),
)
console.log('Fonts are Noto Sans under the SIL Open Font License; see public/fonts/OFL.txt.')
