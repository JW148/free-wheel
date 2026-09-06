#!/usr/bin/env node
/**
 * Draws the app icon: a pixel bike.
 *
 * Written as a 24x24 grid and scaled up with nearest-neighbour, so the result is genuinely
 * pixel art — every edge lands on a pixel boundary at every size, which is exactly what a
 * rasterised SVG would fail to guarantee.
 *
 * PNGs are encoded here rather than shelled out to a converter. The only dependency is
 * `zlib`, which Node has, and it avoids requiring ImageMagick or librsvg on a machine that
 * has neither. A PNG is a signature, three chunks, and a CRC — small enough to be worth
 * owning rather than installing something for.
 *
 *   node tools/make-icons.mjs
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PUBLIC = join(HERE, '..', 'public', 'icons')

// Palette slots, from the app's own slate ramp.
const _ = null // transparent
// Two tones only. The frame is the brightest thing; the wheels sit a step back so the
// silhouette reads before the detail does. A third, darker tone was tried for the cranks and
// looked like a hole punched in the middle of the bike against this background.
const L = '#ccd0cf' // frame, bars, saddle
const M = '#8c9ba1' // wheels and cranks

/**
 * A 32x32 side-on bicycle, composed rather than hand-plotted.
 *
 * Hand-placing a circle on a grid this size produces an octagon — the first attempt did
 * exactly that, and the wheels read as squares. A midpoint circle and Bresenham lines put
 * every pixel where the geometry actually wants it, and the frame joins up because it is
 * drawn as a frame rather than as a picture of one.
 */
const GRID = 32
const grid = Array.from({ length: GRID }, () => Array(GRID).fill(null))

const plot = (x, y, colour) => {
  if (x >= 0 && y >= 0 && x < GRID && y < GRID) grid[y][x] = colour
}

/** Midpoint circle — the outline only, which is what a spoked wheel looks like at this size. */
function ring(cx, cy, radius, colour) {
  let x = radius
  let y = 0
  let error = 1 - radius
  while (x >= y) {
    for (const [px, py] of [
      [x, y], [y, x], [-x, y], [-y, x], [-x, -y], [-y, -x], [x, -y], [y, -x],
    ]) {
      plot(cx + px, cy + py, colour)
    }
    y++
    if (error < 0) error += 2 * y + 1
    else { x--; error += 2 * (y - x) + 1 }
  }
}

/** Bresenham. */
function line(x0, y0, x1, y1, colour) {
  const dx = Math.abs(x1 - x0)
  const dy = -Math.abs(y1 - y0)
  const sx = x0 < x1 ? 1 : -1
  const sy = y0 < y1 ? 1 : -1
  let error = dx + dy
  for (;;) {
    plot(x0, y0, colour)
    if (x0 === x1 && y0 === y1) break
    const e2 = 2 * error
    if (e2 >= dy) { error += dy; x0 += sx }
    if (e2 <= dx) { error += dx; y0 += sy }
  }
}

const REAR = [9, 21]
const FRONT = [24, 21]
const BRACKET = [16, 22]
const SEAT = [13, 11]
const HEAD = [22, 12]

// Wheels first, so the frame draws over them where they meet.
ring(REAR[0], REAR[1], 7, M)
ring(FRONT[0], FRONT[1], 7, M)
plot(REAR[0], REAR[1], M)
plot(FRONT[0], FRONT[1], M)

// Diamond frame: seat tube, down tube, top tube, seat stay, chain stay, fork.
line(BRACKET[0], BRACKET[1], SEAT[0], SEAT[1], L)
line(BRACKET[0], BRACKET[1], HEAD[0], HEAD[1], L)
line(SEAT[0], SEAT[1], HEAD[0], HEAD[1], L)
line(REAR[0], REAR[1], SEAT[0], SEAT[1], L)
line(REAR[0], REAR[1], BRACKET[0], BRACKET[1], L)
line(FRONT[0], FRONT[1], HEAD[0], HEAD[1], L)

// Saddle, seatpost, bars and stem — the parts that say "bicycle" rather than "triangle".
line(SEAT[0], SEAT[1], SEAT[0], SEAT[1] - 2, L)
line(SEAT[0] - 2, SEAT[1] - 3, SEAT[0] + 1, SEAT[1] - 3, L)
line(HEAD[0], HEAD[1], HEAD[0], HEAD[1] - 3, L)
line(HEAD[0] - 1, HEAD[1] - 4, HEAD[0] + 2, HEAD[1] - 4, L)
line(HEAD[0] + 2, HEAD[1] - 4, HEAD[0] + 2, HEAD[1] - 2, L)

// Crank and pedal.
line(BRACKET[0], BRACKET[1], BRACKET[0] - 2, BRACKET[1] + 2, M)
plot(BRACKET[0] - 3, BRACKET[1] + 2, M)

const BIKE = grid

const hex = (value) => [
  parseInt(value.slice(1, 3), 16),
  parseInt(value.slice(3, 5), 16),
  parseInt(value.slice(5, 7), 16),
]

/** PNG's CRC-32, table-free — this runs a handful of times, not in a loop that matters. */
function crc32(buffer) {
  let crc = ~0
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return ~crc >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/**
 * Encodes RGBA pixels as a PNG.
 *
 * Colour type 6 (truecolour with alpha), 8 bits, filter 0 on every scanline — no filtering,
 * because the image is flat colour and deflate handles that better than any predictor would.
 */
function png(width, height, rgba) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // RGBA
  // 10-12: deflate, adaptive filtering, no interlace — all zero.

  const raw = Buffer.alloc(height * (width * 4 + 1))
  for (let y = 0; y < height; y++) {
    const start = y * (width * 4 + 1)
    raw[start] = 0 // filter type: none
    rgba.copy(raw, start + 1, y * width * 4, (y + 1) * width * 4)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Renders the grid at `size` pixels square.
 *
 * `maskable` fills the whole square and insets the art to the safe zone, so Android's
 * arbitrary mask cannot clip a wheel off. `any` keeps a rounded-ish full bleed too — iOS
 * masks the corners itself and an already-rounded icon would be double-rounded.
 */
function render(size, { background }) {
  const rgba = Buffer.alloc(size * size * 4)
  // The art occupies 80% of the canvas; the rest is breathing room, which is roughly the
  // maskable safe zone as well.
  const inset = Math.round(size * 0.1)
  const drawn = size - inset * 2
  const scale = drawn / GRID
  const [br, bg, bb] = hex(background)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4
      rgba[offset] = br
      rgba[offset + 1] = bg
      rgba[offset + 2] = bb
      rgba[offset + 3] = 255

      const gx = Math.floor((x - inset) / scale)
      const gy = Math.floor((y - inset) / scale)
      if (gx < 0 || gy < 0 || gx >= GRID || gy >= GRID) continue
      const cell = BIKE[gy][gx]
      if (!cell) continue
      const [r, g, b] = hex(cell)
      rgba[offset] = r
      rgba[offset + 1] = g
      rgba[offset + 2] = b
      rgba[offset + 3] = 255
    }
  }
  return png(size, size, rgba)
}

mkdirSync(PUBLIC, { recursive: true })

// `#11212d` rather than the deepest slate: a pure-dark icon disappears into a dark home
// screen, and the mid tone keeps the bike's dark frame readable against it.
const BACKGROUND = '#11212d'
const sizes = [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['apple-touch-icon.png', 180],
  ['icon-maskable-512.png', 512],
]

for (const [name, size] of sizes) {
  const buffer = render(size, { background: BACKGROUND })
  writeFileSync(join(PUBLIC, name), buffer)
  console.log(`${name.padEnd(24)} ${size}x${size}  ${(buffer.length / 1024).toFixed(1)} kB`)
}

// A favicon too, so the browser tab is not the generic Vite mark.
writeFileSync(join(HERE, '..', 'public', 'favicon.png'), render(64, { background: BACKGROUND }))
console.log('favicon.png              64x64')
