import { describe, expect, it } from 'vitest'
import type { DataManifest, InstalledRegion } from '../data/manifest'
import type { RegionProgress } from '../engine/downloads'
import {
  actionLabel,
  downloadFailure,
  downloadStatus,
  formatMegabytes,
  itemWords,
  priceLine,
  statesOf,
  statusLine,
  summarise,
  tidyMessage,
} from './pickerModel'

const manifest: DataManifest = {
  version: 1,
  generated: '2026-09-10',
  picker: { url: 'picker/britain.pmtiles', bytes: 4_000_000 },
  segments: {
    W5_N55: { url: 'roads/W5_N55.rd5', bytes: 90_000_000, hash: 'roads-north', changed: '2026-09-01' },
    W5_N50: { url: 'roads/W5_N50.rd5', bytes: 137_000_000, hash: 'roads-south', changed: '2026-09-01' },
  },
  regions: [
    {
      id: 'central-scotland',
      name: 'Central Scotland',
      bbox: [-5, 55.4, -2.4, 56.4],
      basemap: { url: 'regions/central-scotland.pmtiles', bytes: 34_000_000, hash: 'map-scotland', built: '2026-09-08' },
      segments: ['W5_N55'],
    },
    {
      id: 'wessex',
      name: 'Wessex',
      bbox: [-3.2, 50.5, -1.2, 51.6],
      basemap: { url: 'regions/wessex.pmtiles', bytes: 26_000_000, hash: 'map-wessex', built: '2026-09-08' },
      segments: ['W5_N50'],
    },
  ],
}

const installedScotland: InstalledRegion = {
  id: 'central-scotland',
  basemapHash: 'map-scotland',
  segmentHashes: { W5_N55: 'roads-north' },
  installedAt: 0,
}

describe('formatMegabytes', () => {
  it('reads in whole decimal megabytes, which is the number the phone itself shows', () => {
    expect(formatMegabytes(137_000_000)).toBe('137 MB')
    expect(formatMegabytes(34_400_000)).toBe('34 MB')
  })

  it('keeps a decimal place under 10 MB, where rounding would swallow the whole figure', () => {
    expect(formatMegabytes(4_200_000)).toBe('4.2 MB')
  })

  it('never rounds a real download down to nothing', () => {
    expect(formatMegabytes(40_000)).toBe('under 0.1 MB')
    expect(formatMegabytes(0)).toBe('0 MB')
  })
})

describe('itemWords', () => {
  it('names the two things a rider is downloading, and nothing about the files', () => {
    expect(itemWords('basemap')).toBe('the map')
    expect(itemWords('segment')).toBe('the road data')
  })
})

describe('summarise', () => {
  it('prices a fresh region at the map plus the road data', () => {
    const [scotland] = summarise(manifest, [], true)
    expect(scotland.bytes).toBe(34_000_000 + 90_000_000)
    expect(scotland.size).toBe('124 MB')
    expect(scotland.action).toBe('Download')
    expect(scotland.status).toBeNull()
  })

  it('charges nothing for what is already here', () => {
    const [scotland] = summarise(manifest, [installedScotland], true)
    expect(scotland.bytes).toBe(0)
    expect(scotland.state).toBe('current')
    expect(scotland.action).toBe('Use this region')
  })

  it('reports unknown rather than current when the list came from the cache', () => {
    const [scotland] = summarise(manifest, [installedScotland], false)
    expect(scotland.state).toBe('unknown')
    expect(scotland.status).toMatch(/no way to check/)
  })

  it('prices an update at only the part that changed', () => {
    const stale: InstalledRegion = { ...installedScotland, basemapHash: 'map-scotland-old' }
    const [scotland] = summarise(manifest, [stale], true)
    expect(scotland.state).toBe('map-outdated')
    expect(scotland.bytes).toBe(34_000_000)
    expect(scotland.action).toBe('Update')
  })

  it('leaves out a region it cannot price rather than showing one without a size', () => {
    const broken: DataManifest = {
      ...manifest,
      regions: [
        { ...manifest.regions[0], segments: ['W5_N45'] },
        manifest.regions[1],
      ],
    }
    expect(summarise(broken, [], true).map((s) => s.id)).toEqual(['wessex'])
  })

  it('hands the outline layer a state for every region it lists', () => {
    const summaries = summarise(manifest, [installedScotland], true)
    expect(statesOf(summaries)).toEqual({ 'central-scotland': 'current', wessex: 'not-installed' })
  })
})

describe('priceLine', () => {
  it('puts the number in front of the button, with no invented warning around it', () => {
    expect(priceLine('not-installed', 124_000_000, '124 MB')).toBe(
      '124 MB — the map and the road data for this area.',
    )
  })

  it('does not charge an update for both halves when only one changed', () => {
    expect(priceLine('map-outdated', 34_000_000, '34 MB')).toBe(
      '34 MB to bring this region up to date.',
    )
  })

  it('says so plainly when there is nothing to fetch', () => {
    expect(priceLine('current', 0, '0 MB')).toBe('Everything this region needs is already on the phone.')
  })
})

describe('actionLabel', () => {
  it('does not offer to update nothing when a shared download already covered it', () => {
    expect(actionLabel('road-data-outdated', 0)).toBe('Use this region')
    expect(actionLabel('road-data-outdated', 1)).toBe('Update')
  })
})

describe('statusLine', () => {
  it('says nothing about a region with nothing on the phone', () => {
    expect(statusLine('not-installed')).toBeNull()
  })

  it('never claims a cached list proves a region is current', () => {
    expect(statusLine('current')).toBe('Already on this phone, and up to date.')
    expect(statusLine('unknown')).toMatch(/no way to check/)
    expect(statusLine('unknown')).not.toBe(statusLine('current'))
  })
})

const progress = (over: Partial<RegionProgress> = {}): RegionProgress => ({
  key: 'central-scotland',
  kind: 'basemap',
  received: 17_000_000,
  total: 34_000_000,
  overallReceived: 17_000_000,
  overallTotal: 124_000_000,
  state: 'downloading',
  ...over,
})

describe('downloadStatus', () => {
  it('tracks the whole region, not the file, so the bar only ever moves forward', () => {
    expect(downloadStatus(progress()).percent).toBe(14)
    expect(downloadStatus(progress({ kind: 'segment', received: 90_000_000, total: 90_000_000, overallReceived: 124_000_000 })).percent).toBe(100)
  })

  it('names the current file in words', () => {
    expect(downloadStatus(progress()).line).toBe('Downloading the map — 17 MB of 34 MB')
    expect(downloadStatus(progress({ kind: 'segment', received: 45_000_000, total: 90_000_000 })).line).toBe(
      'Downloading the road data — 45 MB of 90 MB',
    )
  })

  it('stops claiming to download once everything is down but nothing is committed yet', () => {
    const done = progress({ state: 'complete', overallReceived: 124_000_000, received: 34_000_000 })
    expect(downloadStatus(done)).toEqual({ percent: 100, line: 'Finishing up…' })
  })

  it('survives a region with nothing to fetch rather than putting NaN in the bar', () => {
    expect(downloadStatus(progress({ overallReceived: 0, overallTotal: 0 })).percent).toBe(0)
  })

  it('has something to say before the first byte arrives', () => {
    expect(downloadStatus(null)).toEqual({ percent: 0, line: 'Starting…' })
  })
})

describe('tidyMessage', () => {
  it('strips the URL the download layer prefixes its errors with', () => {
    expect(
      tidyMessage(new Error('https://data.example.com/roads/W5_N50.rd5: server returned 503')),
    ).toBe('server returned 503')
  })

  it('leaves no file name anywhere a rider can read it', () => {
    const tidied = tidyMessage(new Error('could not open https://data.example.com/regions/wessex.pmtiles'))
    expect(tidied).not.toMatch(/pmtiles|rd5/)
    expect(tidied).toBe('could not open the download')
  })

  it('always has something to show, even for an error with no message', () => {
    expect(tidyMessage(new Error(''))).toBe('something went wrong')
  })

  it('scrubs the words the rest of the app uses, which reach here through thrown messages', () => {
    // Verbatim from `manifest.ts`, `regionStore.ts` and `opfsVfs.ts` — a corrupted saved copy
    // and a broken storage layer both surface on this screen.
    expect(tidyMessage(new Error('segment name W5_N45 is not a valid grid cell id'))).toBe(
      'road data name W5_N45 is not a valid grid cell id',
    )
    expect(tidyMessage(new Error('segment directory /segments4 does not exist'))).toBe(
      'road data directory /road data does not exist',
    )
    expect(tidyMessage(new Error('OPFS is unavailable in this context'))).toBe(
      'storage is unavailable in this context',
    )
    expect(tidyMessage(new Error('tile W5_N50.rd5 is truncated'))).toBe(
      'map data W5_N50 is truncated',
    )
  })

  it('drops a message it could not make safe rather than showing it', () => {
    // A compound identifier is the shape a word-boundary scrub cannot reach. The guarantee is
    // the looser check that follows the scrub, not the scrub itself.
    expect(tidyMessage(new Error('unreadable TILEDATA'))).toBe('something went wrong')
    expect(tidyMessage(new Error('subsegment index is corrupt'))).toBe('something went wrong')
  })
})

describe('downloadFailure', () => {
  it('calls out the one failure a retry alone cannot fix', () => {
    const quota = new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    const { message, advice } = downloadFailure(quota)
    expect(message).toMatch(/not enough room/)
    expect(advice).toMatch(/remov/i)
  })

  it('tells a rider the retry resumes, which is what decides whether they press it', () => {
    const dropped = downloadFailure(new TypeError('Load failed'))
    expect(dropped.message).toBe('The connection dropped.')
    expect(dropped.advice).toMatch(/picks up where it stopped/)
  })

  it('separates a server fault from a phone fault', () => {
    const { message } = downloadFailure(new Error('https://data.example.com/roads/W5_N50.rd5: server returned 503'))
    expect(message).toBe('The download server answered 503.')
  })

  it('names a truncated transfer without quoting byte counts at a rider', () => {
    const { message } = downloadFailure(
      new Error('https://data.example.com/regions/wessex.pmtiles: expected 26000000 bytes, wrote 91234'),
    )
    expect(message).toBe('The download stopped before it finished.')
  })

  it('shows an unrecognised message rather than swallowing it, minus the file names', () => {
    const { message } = downloadFailure(new Error('https://data.example.com/regions/wessex.pmtiles: it broke'))
    expect(message).toBe('The download stopped: it broke.')
    expect(message).not.toMatch(/pmtiles/)
  })

  const forbidden = /\.rd5|\.pmtiles|segment|OPFS|\btile\b/i

  it('never puts an implementation word in front of a rider, whatever the error was', () => {
    const errors: unknown[] = [
      new Error('https://data.example.com/roads/W5_N50.rd5: server returned 404'),
      new Error('https://data.example.com/regions/wessex.pmtiles: expected 1 bytes, wrote 0'),
      new DOMException('quota', 'QuotaExceededError'),
      new TypeError('Failed to fetch'),
      'a bare string',
    ]
    for (const error of errors) {
      const { message, advice } = downloadFailure(error)
      expect(message).not.toMatch(forbidden)
      expect(advice ?? '').not.toMatch(forbidden)
    }
  })
})
