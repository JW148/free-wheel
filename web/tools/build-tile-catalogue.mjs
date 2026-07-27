#!/usr/bin/env node
/**
 * Builds `web/public/engine/tile-catalogue.json` from brouter.de's segments4 directory index.
 *
 * The catalogue exists so the region picker can quote real sizes before downloading anything.
 * That matters more than it sounds: the plan cites a "median 1.2 MB" tile, which is true but
 * badly misleading — the median is dominated by ocean and empty land. The tiles anyone
 * actually wants are two orders of magnitude bigger (W5_N50, covering southern Britain, is
 * 137 MB). Quoting the median in a UI would understate a real download by ~100x.
 *
 * Run occasionally, not at build time: it scrapes a third party's index page, and the sizes
 * only drift as OSM data grows. Actual downloads use the real content-length regardless, so a
 * slightly stale catalogue costs nothing but a marginally wrong estimate.
 *
 * Usage: node tools/build-tile-catalogue.mjs
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', 'public', 'engine', 'tile-catalogue.json')
const INDEX = 'https://brouter.de/brouter/segments4/'

// nginx autoindex line: <a href="NAME">NAME</a>   DD-Mon-YYYY HH:MM   SIZE
const ROW = /<a href="([EW]\d+_[NS]\d+\.rd5)">[^<]*<\/a>\s+(\S+\s+\S+)\s+(\d+)/g

const response = await fetch(INDEX)
if (!response.ok) {
  throw new Error(`could not fetch ${INDEX}: ${response.status}`)
}
const html = await response.text()

const tiles = {}
let total = 0
for (const [, name, modified, size] of html.matchAll(ROW)) {
  tiles[name.replace(/\.rd5$/, '')] = { bytes: Number(size), modified }
  total += Number(size)
}

const names = Object.keys(tiles)
if (names.length < 1000) {
  throw new Error(`only parsed ${names.length} tiles — has the index format changed?`)
}

const sizes = names.map((n) => tiles[n].bytes).sort((a, b) => a - b)
const catalogue = {
  source: INDEX,
  generated: new Date().toISOString().slice(0, 10),
  tileCount: names.length,
  totalBytes: total,
  medianBytes: sizes[Math.floor(sizes.length / 2)],
  largestBytes: sizes[sizes.length - 1],
  tiles,
}

await mkdir(dirname(OUT), { recursive: true })
await writeFile(OUT, JSON.stringify(catalogue), 'utf8')

const mb = (n) => (n / 1e6).toFixed(1) + ' MB'
console.log(`wrote ${OUT}`)
console.log(`  ${names.length} tiles, ${(total / 1e9).toFixed(2)} GB total`)
console.log(`  median ${mb(catalogue.medianBytes)}, largest ${mb(catalogue.largestBytes)}`)
