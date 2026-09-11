import { describe, expect, it } from 'vitest'
import { basemapStyle } from './style'

// `basemapStyle` resolves glyph and sprite URLs against the document origin — see the same
// stub in `style.test.ts`. Under Node there is no `location`, so stand one up.
Object.defineProperty(globalThis, 'location', {
  value: new URL('http://localhost:4174/'),
  configurable: true,
})

describe('basemapStyle with a remote archive', () => {
  it('addresses an https archive through the pmtiles protocol', () => {
    const style = basemapStyle('https://example.com/uk-z10-8f3a1c2d.pmtiles', 'dark', 'rideable')
    const source = style.sources.basemap as { url: string }
    expect(source.url).toBe('pmtiles://https://example.com/uk-z10-8f3a1c2d.pmtiles')
  })

  it('still addresses a local archive by bare name', () => {
    const style = basemapStyle('edinburgh.pmtiles', 'dark', 'rideable')
    const source = style.sources.basemap as { url: string }
    expect(source.url).toBe('pmtiles://edinburgh.pmtiles')
  })
})
