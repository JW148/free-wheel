import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseBrouterGpx, parseTrackGpx, formatDistance, formatDuration, hasHeights } from './gpx'
import { startRecording, recordFix, traceToGpx, type RideSample } from './recording'

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), 'utf8')

describe('parseBrouterGpx', () => {
  describe('against real BRouter output', () => {
    // These two files are verbatim `./gradlew jvmRoutes` output — the same bytes the Wasm
    // engine is checked against. Testing the parser on anything hand-written would only
    // prove it parses what I imagined BRouter emits.
    const short = parseBrouterGpx(fixture('urban-short.gpx'))
    const long = parseBrouterGpx(fixture('london-brighton.gpx'))

    it('reads the summary out of the header comment', () => {
      // <!-- track-length = 1964 filtered ascend = 1 plain-ascend = -2 cost=2975
      //      energy=.0kwh time=5m 23s -->
      expect(short.distanceM).toBe(1964)
      expect(short.ascendM).toBe(1)
      expect(short.timeS).toBe(5 * 60 + 23)
    })

    it('reads a multi-hour time', () => {
      expect(long.distanceM).toBeGreaterThan(70_000)
      // 76 km on a trekking profile is hours, not minutes — the `Nh Nm Ns` branch.
      expect(long.timeS).toBeGreaterThan(3600)
    })

    it('extracts every track point in order', () => {
      const trkptCount = fixture('urban-short.gpx').match(/<trkpt /g)?.length
      expect(short.coords).toHaveLength(trkptCount!)

      // First and last, straight out of the file.
      expect(short.coords[0]).toEqual([-0.127818, 51.507392])
      expect(short.coords.at(-1)).toEqual([-0.141834, 51.5005])
    })

    it('keeps coordinates in GeoJSON order, not GPX attribute order', () => {
      // GPX writes lon then lat here, but that is incidental. Longitude near London is
      // ~0 and latitude ~51, so a transposition would be obvious.
      for (const [lon, lat] of short.coords) {
        expect(Math.abs(lon)).toBeLessThan(1)
        expect(lat).toBeGreaterThan(50)
      }
    })

    it('extracts elevations alongside the coordinates', () => {
      expect(short.elevations).toHaveLength(short.coords.length)
      expect(short.elevations[0]).toBe(8.0)
      expect(short.elevations[1]).toBe(8.25)
    })

    it('reads the track name', () => {
      expect(short.name).toBe('brouter_trekking_0')
    })

    it('handles a large track without truncating', () => {
      expect(long.coords.length).toBeGreaterThan(2000)
      expect(long.elevations).toHaveLength(long.coords.length)
    })
  })

  describe('summary parsing', () => {
    const withComment = (comment: string) =>
      parseBrouterGpx(
        `<?xml version="1.0" encoding="UTF-8"?>\n<!-- ${comment} -->\n` +
          `<gpx><trk><name>t</name><trkseg>\n` +
          `<trkpt lon="-3.19" lat="55.95"><ele>50.0</ele></trkpt>\n` +
          `<trkpt lon="-3.18" lat="55.96"><ele>60.0</ele></trkpt>\n` +
          `</trkseg></trk></gpx>`,
      )

    it('returns null time when the profile carries no energy model', () => {
      // Without `energy=`, BRouter appends no `time=` at all — a shortest-path profile
      // does this. Reporting 0 minutes would be a lie; null lets the UI omit it.
      const route = withComment('track-length = 1964 filtered ascend = 1 plain-ascend = -2 cost=2975')
      expect(route.timeS).toBeNull()
      expect(route.distanceM).toBe(1964)
    })

    it('parses each component of the time independently', () => {
      const time = (s: string) =>
        withComment(`track-length = 1 filtered ascend = 0 plain-ascend = 0 cost=1 energy=.0kwh time=${s}`)
          .timeS

      expect(time('23s')).toBe(23)
      expect(time('5m ')).toBe(300)
      expect(time('5m 23s')).toBe(323)
      expect(time('2h ')).toBe(7200)
      expect(time('2h 5m ')).toBe(7500)
      expect(time('2h 5m 23s')).toBe(7523)
    })

    it('accepts a negative ascend', () => {
      // `filtered ascend` is what the UI shows; it is non-negative in practice, but
      // `plain-ascend` next to it can be negative and the two must not be confused.
      const route = withComment('track-length = 500 filtered ascend = 0 plain-ascend = -42 cost=1')
      expect(route.ascendM).toBe(0)
    })

    it('defaults the summary to zero when the comment is absent entirely', () => {
      const route = parseBrouterGpx(
        `<gpx><trk><trkseg><trkpt lon="-3.19" lat="55.95"/></trkseg></trk></gpx>`,
      )
      expect(route.distanceM).toBe(0)
      expect(route.ascendM).toBe(0)
      expect(route.timeS).toBeNull()
      expect(route.coords).toHaveLength(1)
    })
  })

  describe('malformed input', () => {
    it('rejects a BRouter error string rather than returning an empty route', () => {
      // `Router.route` returns `error:…` as a *string*, so this is a real shape the caller
      // can hand us. Silently yielding zero points would draw an empty line on the map.
      expect(() => parseBrouterGpx('error:datafile W5_N55.rd5 not found')).toThrow(/not found/)
    })

    it('rejects a document with no track points', () => {
      expect(() => parseBrouterGpx('<gpx><trk><trkseg></trkseg></trk></gpx>')).toThrow(
        /no track points/i,
      )
    })

    it('tolerates a track point with no elevation', () => {
      const route = parseBrouterGpx(
        `<gpx><trk><trkseg><trkpt lon="-3.19" lat="55.95"/></trkseg></trk></gpx>`,
      )
      expect(route.coords).toEqual([[-3.19, 55.95]])
      expect(route.elevations).toEqual([0])
    })

    it('does not care about attribute order', () => {
      const route = parseBrouterGpx(
        `<gpx><trk><trkseg><trkpt lat="55.95" lon="-3.19"><ele>7</ele></trkpt></trkseg></trk></gpx>`,
      )
      expect(route.coords).toEqual([[-3.19, 55.95]])
    })
  })
})

describe('formatDistance', () => {
  it('uses metres below a kilometre', () => {
    expect(formatDistance(0)).toBe('0 m')
    expect(formatDistance(940)).toBe('940 m')
  })

  it('uses kilometres to one decimal above that', () => {
    expect(formatDistance(1964)).toBe('2.0 km')
    expect(formatDistance(76_432)).toBe('76.4 km')
  })
})

describe('formatDuration', () => {
  it('renders minutes below an hour', () => {
    expect(formatDuration(323)).toBe('5 min')
  })

  it('renders hours and minutes above it', () => {
    expect(formatDuration(7523)).toBe('2h 05m')
  })

  it('renders a dash for an unknown duration', () => {
    expect(formatDuration(null)).toBe('—')
  })
})

/**
 * Reading back a ride the app recorded.
 *
 * The fixture is generated rather than checked in, and deliberately: it is produced by feeding
 * `recordFix` a made-up ride and asking `traceToGpx` to write it, which is exactly the path a
 * real ride takes. A stored file would let the writer and the reader drift apart, and the
 * whole point of this pair is that a track written on Sunday can be followed on Wednesday.
 */
describe('parseTrackGpx', () => {
  const ride = (elevate: boolean) => {
    let record = startRecording(0)
    for (let i = 0; i < 30; i++) {
      const sample: RideSample = {
        at: i * 1000,
        // ~11 m of longitude per step at 55°N, comfortably past the 6 m minimum step.
        lon: -3.2 + i * 0.0002,
        lat: 55.94,
        accuracyM: 8,
        speedMps: 6,
        powerW: 140,
        routeElevM: elevate ? 60 + i * 2 : null,
      }
      record = recordFix(record, sample)
    }
    return record
  }

  it('reads back the track it wrote, with its heights', () => {
    const record = ride(true)
    const parsed = parseTrackGpx(traceToGpx(record, 'Tuesday loop'))
    expect(parsed.coords.length).toBe(record.trace.length)
    expect(parsed.coords[0]).toEqual([
      Number(record.trace[0].lon.toFixed(6)),
      Number(record.trace[0].lat.toFixed(6)),
    ])
    expect(hasHeights(parsed)).toBe(true)
    expect(parsed.name).toBe('Tuesday loop')
  })

  it('measures the distance, because a recorded ride carries no summary to read', () => {
    const record = ride(true)
    const parsed = parseTrackGpx(traceToGpx(record, 'x'))
    // Within 10% of what the recorder accumulated. Not equal: the trace is thinned to 10 m,
    // so summing it cuts the corners the recorder counted.
    expect(parsed.distanceM).toBeGreaterThan(record.distanceM * 0.9)
    expect(parsed.distanceM).toBeLessThan(record.distanceM * 1.1)
  })

  it('reports no heights for a ride recorded with no route to take them from', () => {
    const parsed = parseTrackGpx(traceToGpx(ride(false), 'Free ride'))
    expect(hasHeights(parsed)).toBe(false)
    // And no invented climbing figure to go with them.
    expect(parsed.ascendM).toBe(0)
  })

  it('refuses a document with nothing to follow rather than drawing an empty line', () => {
    expect(() => parseTrackGpx('<gpx></gpx>')).toThrow(/no track/i)
  })

  it('would have been read as a zero-length route by the engine parser', () => {
    // The reason this function exists. `parseBrouterGpx` finds the points and no summary, so
    // it reports a route of length zero — which the progress bar then divides by.
    const gpx = traceToGpx(ride(true), 'x')
    expect(parseBrouterGpx(gpx).distanceM).toBe(0)
    expect(parseTrackGpx(gpx).distanceM).toBeGreaterThan(100)
  })
})

describe('hasHeights', () => {
  it('is true for anything the engine computed', () => {
    expect(hasHeights(parseBrouterGpx(fixture('urban-short.gpx')))).toBe(true)
  })
})
