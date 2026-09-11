import { beforeEach, describe, expect, it } from 'vitest'
import { installFakeOpfs } from './fakeOpfs'

/**
 * The handle registry and the VFS bridge, against a fake OPFS rather than a fake `opfsVfs`.
 *
 * This mechanism — hide a file that a download left short, so BRouter reports an honest "no
 * data here" instead of parsing a truncated `.rd5` as corrupt — had produced the same bug three
 * times before these tests existed, because nothing exercised it. Inverting `isPending`, or
 * dropping its check from any one of the five bridge lookups, left the whole suite green.
 *
 * So the assertions below are deliberately about the *observable* thing: what `freeWheelVfs`,
 * the object BRouter actually reads through, says about a file. Not about which flag is set.
 */
const opfs = installFakeOpfs()

const {
  clearPending,
  closeOpfs,
  installVfsBridge,
  knownSize,
  markPending,
  openHandle,
  peekFileSize,
  refreshSize,
  removeFile,
} = await import('./opfsVfs')

const TILE = '/segments4/W5_N50.rd5'

interface Bridge {
  exists(path: string): boolean
  isFile(path: string): boolean
  isDirectory(path: string): boolean
  size(path: string): number
  list(path: string): string
  read(path: string, position: number, length: number): Int8Array
}

function bridge(): Bridge {
  installVfsBridge()
  return (globalThis as unknown as { freeWheelVfs: Bridge }).freeWheelVfs
}

/** Opens `path` and puts `bytes` bytes in it, the way a download or an import would. */
async function writeFile(path: string, bytes: number): Promise<void> {
  const handle = await openHandle(path)
  handle.truncate(0)
  handle.write(new Uint8Array(bytes).fill(7), { at: 0 })
  handle.flush()
  refreshSize(path)
}

beforeEach(() => {
  closeOpfs()
  opfs.reset()
})

describe('the pending marker, as BRouter sees it', () => {
  it('hides a file short of its target from every lookup the bridge offers', async () => {
    await writeFile(TILE, 100)
    const vfs = bridge()

    // Present before anything marks it — otherwise the assertions below prove nothing.
    expect(vfs.exists(TILE)).toBe(true)
    expect(vfs.size(TILE)).toBe(100)

    markPending(TILE, 200)

    expect(vfs.exists(TILE)).toBe(false)
    expect(vfs.isFile(TILE)).toBe(false)
    expect(vfs.size(TILE)).toBe(-1)
    expect(vfs.list('/segments4')).toBe('')
    expect(vfs.read(TILE, 0, 50)).toHaveLength(0)
  })

  it('leaves the segment directory itself in place while a tile of it is hidden', async () => {
    await writeFile(TILE, 100)
    const vfs = bridge()
    markPending(TILE, 200)

    // BRouter fails with "segment directory /segments4 does not exist" if this goes too — a
    // different and much more confusing error than the honest "no data for this area".
    expect(vfs.isDirectory('/segments4')).toBe(true)
    expect(vfs.exists('/segments4')).toBe(true)
  })

  it('shows the file again once its size reaches the target', async () => {
    await writeFile(TILE, 100)
    const vfs = bridge()
    markPending(TILE, 200)
    expect(vfs.exists(TILE)).toBe(false)

    await writeFile(TILE, 200)

    expect(vfs.exists(TILE)).toBe(true)
    expect(vfs.isFile(TILE)).toBe(true)
    expect(vfs.size(TILE)).toBe(200)
    expect(vfs.list('/segments4')).toBe('W5_N50.rd5')
    expect(vfs.read(TILE, 0, 50)).toHaveLength(50)
  })

  it('shows a file that overshoots its target, rather than hiding anything unequal to it', async () => {
    // Guards the comparison's direction. `size > targetSize` and `size !== targetSize` both
    // pass the test above and both hide a complete file here — the first for every file that
    // ever gets marked, the second for one the mirror served long.
    await writeFile(TILE, 300)
    markPending(TILE, 200)
    expect(bridge().exists(TILE)).toBe(true)
  })

  it('shows a still-short file again when the marker is cleared', async () => {
    // The hand-import case: a download of W5_N50 died mid-segment and marked 143,654,912 bytes;
    // the rider imports brouter.de's current build, which is smaller, and the file is complete
    // and correct at that smaller size. Nothing about its length will ever clear the marker, so
    // the import has to.
    await writeFile(TILE, 100)
    const vfs = bridge()
    markPending(TILE, 200)
    expect(vfs.exists(TILE)).toBe(false)

    clearPending(TILE)

    expect(vfs.exists(TILE)).toBe(true)
    expect(vfs.isFile(TILE)).toBe(true)
    expect(vfs.size(TILE)).toBe(100)
    expect(vfs.list('/segments4')).toBe('W5_N50.rd5')
    expect(vfs.read(TILE, 0, 100)).toHaveLength(100)
  })

  it('drops the marker with the file when it is removed', async () => {
    await writeFile(TILE, 100)
    markPending(TILE, 200)

    await removeFile(TILE)
    await writeFile(TILE, 100)

    expect(bridge().exists(TILE)).toBe(true)
    expect(knownSize(TILE)).toBe(100)
  })

  it('starts every path unmarked in a fresh session', async () => {
    await writeFile(TILE, 100)
    markPending(TILE, 200)

    // A Worker restart: the registry is in-memory, so it goes and the file is judged on its
    // own bytes again. The durable half of the marker (`/downloads.json`) is what survives.
    closeOpfs()
    await openHandle(TILE)

    expect(bridge().exists(TILE)).toBe(true)
  })

  it('does not mark a path nothing has opened', async () => {
    markPending(TILE, 200)
    await writeFile(TILE, 100)
    expect(bridge().exists(TILE)).toBe(true)
  })
})

describe('peekFileSize', () => {
  it('sizes a file this session never opened, without registering it', async () => {
    opfs.write(TILE, 100)

    expect(await peekFileSize(TILE)).toBe(100)
    // Still unregistered: opening is what exposes a path to BRouter, and an orphan left by an
    // interrupted download must be judged before that, not after.
    expect(knownSize(TILE)).toBe(-1)
    expect(bridge().exists(TILE)).toBe(false)
  })

  it('answers from the registry for a path that is already open', async () => {
    await writeFile(TILE, 100)
    expect(await peekFileSize(TILE)).toBe(100)
  })

  it('reports absence as -1 for a missing file and a missing directory', async () => {
    opfs.write(TILE, 100)
    expect(await peekFileSize('/segments4/E10_N40.rd5')).toBe(-1)
    expect(await peekFileSize('/basemap/wessex.pmtiles')).toBe(-1)
  })

  it('creates nothing on the way to a missing path', async () => {
    await peekFileSize('/basemap/wessex.pmtiles')
    expect(opfs.hasDirectory('/basemap')).toBe(false)
    expect(opfs.paths()).toEqual([])
  })

  it('throws rather than reporting absence when a file cannot be sized', async () => {
    // A second tab holding the file. -1 would be a lie with teeth: `isTruncated` reads it as
    // "shorter than target" and drops a perfectly good tile out of `installedTiles()`.
    opfs.write(TILE, 100)
    opfs.jam(TILE)
    await expect(peekFileSize(TILE)).rejects.toThrow('could not be sized')
  })

  it('throws rather than reporting absence when the path is not a file', async () => {
    opfs.write(`${TILE}/somehow-a-directory`, 10)
    await expect(peekFileSize(TILE)).rejects.toThrow(/TypeMismatch|is a directory/)
  })

  it('throws rather than reporting absence when a directory cannot be walked', async () => {
    // A file sitting where /segments4 should be. Not absence either, and the two halves of the
    // peek have to agree about that or the convention is decided by which one happens to fail.
    opfs.write('/segments4', 10)
    await expect(peekFileSize(TILE)).rejects.toThrow(/TypeMismatch|is a file/)
  })
})

describe('the handle registry', () => {
  it('hands both callers the same handle rather than opening a file twice', async () => {
    // OPFS allows one sync access handle per file; the fake enforces it, as a device does. The
    // engine's VFS and the downloader both want this file, so the registry has to share.
    const [first, second] = await Promise.all([openHandle(TILE), openHandle(TILE)])
    expect(first).toBe(second)
  })
})
