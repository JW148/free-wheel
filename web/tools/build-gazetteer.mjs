#!/usr/bin/env node
/**
 * Builds `public/gazetteer.json`: every British town worth naming, and where it is.
 *
 * ## What it is for, which is one screen
 *
 * A rider types "Aberystwyth" and has not downloaded Mid and West Wales. Without this the app
 * can only say "no results", which is indistinguishable from "that is not a place" — so the
 * rider concludes the search is broken rather than that they are missing a region. With it the
 * app says where Aberystwyth is, which region covers it, and offers to download that region.
 * That is the whole feature: turning a dead end into a task, which is the same thing
 * `explainRoutingFailure` does for a missing `.rd5`.
 *
 * It deliberately does **not** make anywhere routable. A gazetteer hit is a place on the map
 * and nothing else; the region download is what makes it a destination.
 *
 * ## Run by hand, output committed
 *
 * Same arrangement as `build-tile-catalogue.mjs` and `web/public/engine`: a static host cannot
 * run this, because it needs a Britain-wide PMTiles archive that is far too big to commit. Cut
 * one with the command in CLAUDE.md, run this, commit the JSON.
 *
 *     ~/bin/pmtiles extract https://build.protomaps.com/<date>.pmtiles /tmp/gb-z10.pmtiles \
 *       --bbox=-8.7,49.8,2.0,61.0 --maxzoom=10
 *     node tools/build-gazetteer.mjs /tmp/gb-z10.pmtiles
 *
 * ## Why z10, and why `min_zoom <= 10`
 *
 * Protomaps stamps every place with the zoom at which it is first worth drawing, and that is a
 * far better definition of "a town somebody would type" than a population threshold: it already
 * accounts for a place being the only thing for forty miles. At 10 that is 1,719 places, about
 * 40 kB. Going one step further to 11 is 15,458 — every hamlet in the country, a 300 kB file
 * precached on every phone, to answer a question the region's own index answers better once it
 * is downloaded.
 */

import { openSync, readSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { PMTiles } from 'pmtiles'

const require = createRequire(import.meta.url)
const { VectorTile } = require('@mapbox/vector-tile')
const { PbfReader } = require('pbf')

/** Below this a place is a hamlet, and the region index is the better place to find it. */
const MAX_MIN_ZOOM = 10

/** Coordinates are stored as hundred-thousandths of a degree: about 1 m, in half the bytes. */
const SCALE = 1e5

class FileSource {
  constructor(path) {
    this.fd = openSync(path, 'r')
    this.key = path
  }
  getKey() {
    return this.key
  }
  async getBytes(offset, length) {
    const buffer = Buffer.alloc(length)
    readSync(this.fd, buffer, 0, length, offset)
    return { data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + length) }
  }
}

const source = process.argv[2]
if (!source) {
  console.error('usage: node tools/build-gazetteer.mjs <britain.pmtiles>')
  process.exit(1)
}

const archive = new PMTiles(new FileSource(source))
const header = await archive.getHeader()
const z = Math.min(header.maxZoom, MAX_MIN_ZOOM)

const lonToX = (lon) => Math.floor(((lon + 180) / 360) * 2 ** z)
const latToY = (lat) => {
  const r = (lat * Math.PI) / 180
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z)
}

const places = new Map()
for (let x = lonToX(header.minLon); x <= lonToX(header.maxLon); x++) {
  for (let y = latToY(header.maxLat); y <= latToY(header.minLat); y++) {
    const tile = await archive.getZxy(z, x, y)
    if (!tile) continue
    const layer = new VectorTile(new PbfReader(new Uint8Array(tile.data))).layers.places
    if (!layer) continue
    for (let i = 0; i < layer.length; i++) {
      const feature = layer.feature(i)
      const name = feature.properties.name
      if (!name) continue
      if ((feature.properties.min_zoom ?? 99) > MAX_MIN_ZOOM) continue
      const point = feature.loadGeometry()[0][0]
      const lon = ((x + point.x / layer.extent) / 2 ** z) * 360 - 180
      const n = Math.PI - (2 * Math.PI * (y + point.y / layer.extent)) / 2 ** z
      const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
      // Keyed by name alone: two towns of the same name at this scale is a duplicate of one
      // town straddling a tile edge far more often than it is two towns.
      if (!places.has(name)) places.set(name, { name, lon, lat })
    }
  }
}

const ordered = [...places.values()].sort((a, b) => a.name.localeCompare(b.name))
const out = {
  v: 1,
  builtAt: new Date().toISOString().slice(0, 10),
  source: source.split('/').pop(),
  names: ordered.map((p) => p.name).join('\n'),
  lon: ordered.map((p) => Math.round(p.lon * SCALE)),
  lat: ordered.map((p) => Math.round(p.lat * SCALE)),
}

const target = fileURLToPath(new URL('../public/gazetteer.json', import.meta.url))
writeFileSync(target, JSON.stringify(out))
console.log(`${ordered.length} places -> public/gazetteer.json`)
