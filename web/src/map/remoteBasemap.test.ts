import { describe, expect, it } from 'vitest'
import { basemapStyle, sourceIdFor } from './style'

// `basemapStyle` resolves glyph and sprite URLs against the document origin — see the same
// stub in `style.test.ts`. Under Node there is no `location`, so stand one up.
Object.defineProperty(globalThis, 'location', {
  value: new URL('http://localhost:4174/'),
  configurable: true,
})

const urlOf = (archive: string) =>
  (basemapStyle(archive, 'dark', 'rideable').sources[sourceIdFor(archive)] as { url: string }).url

describe('basemapStyle with a remote archive', () => {
  it('addresses an https archive through the pmtiles protocol', () => {
    // The source id is derived from the archive, and an archive may be a URL — which is why
    // the separator is `|` rather than the `:` a URL contains.
    expect(urlOf('https://example.com/uk-z10-8f3a1c2d.pmtiles')).toBe(
      'pmtiles://https://example.com/uk-z10-8f3a1c2d.pmtiles',
    )
  })

  it('still addresses a local archive by bare name', () => {
    expect(urlOf('edinburgh.pmtiles')).toBe('pmtiles://edinburgh.pmtiles')
  })
})
