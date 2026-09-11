/**
 * An in-memory stand-in for the **browser's** OPFS API, for tests.
 *
 * Test-only: nothing in the app imports it, so it is never bundled. It lives in `src/` rather
 * than beside the tests because three test files share it, and a copy per file is how two of
 * them would drift apart.
 *
 * The seam is deliberately underneath `opfsVfs.ts`, not around it. Mocking `opfsVfs` itself —
 * which an earlier round of `tileStore.test.ts` did — leaves the registry, the `targetSize`
 * marker and the VFS bridge entirely unexercised, which is exactly how three rounds of
 * marker-lifetime bugs reached the branch with a green suite. Faking
 * `navigator.storage.getDirectory()` instead means the real `opfsVfs.ts`, `partials.ts` and
 * `tileStore.ts` run, and a test can ask the question that matters: after this, is the file
 * visible to BRouter?
 *
 * What it models: a directory tree, files as byte arrays, sync access handles, and OPFS's one
 * rule that actually shapes this codebase — **one open sync access handle per file**, so a
 * second `createSyncAccessHandle()` on a still-open file throws `InvalidStateError` just as it
 * does on a device. What it does not model: quota, eviction, cross-tab lock timing, or
 * `getFile()`'s behaviour on a file another context has locked — {@link FakeOpfs.jam} stands in
 * for that last one, because the interesting part is only how `peekFileSize` reacts to it.
 *
 * One more gap worth knowing before trusting a green test here: a **closed** sync access handle
 * keeps reading and writing in this fake, where a real one throws `InvalidStateError`. So a use
 * after `close()` — the bug `VirtualFileAccessor.close()` being a deliberate no-op exists to
 * avoid — passes here and would fail on a device. Nothing in these tests does it, but a test
 * that started to would not be told.
 */

interface FakeFile {
  bytes: Uint8Array
  /** A sync access handle is open on this file. */
  open: boolean
  /** `getFile()` should fail, standing in for a lock held by another context. */
  jammed: boolean
}

function notFound(name: string): DOMException {
  return new DOMException(`${name} not found`, 'NotFoundError')
}

class FakeFileHandle {
  readonly kind = 'file'
  readonly name: string
  readonly file: FakeFile

  constructor(name: string, file: FakeFile) {
    this.name = name
    this.file = file
  }

  async createSyncAccessHandle() {
    if (this.file.open) {
      throw new DOMException(
        `Access Handles cannot be created if there is another open Access Handle on ${this.name}`,
        'InvalidStateError',
      )
    }
    this.file.open = true
    const file = this.file
    return {
      getSize: () => file.bytes.length,
      truncate: (size: number) => {
        const next = new Uint8Array(size)
        next.set(file.bytes.subarray(0, Math.min(size, file.bytes.length)))
        file.bytes = next
      },
      write: (buffer: ArrayBufferView, options?: { at?: number }) => {
        const at = options?.at ?? 0
        const chunk = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
        if (at + chunk.length > file.bytes.length) {
          const grown = new Uint8Array(at + chunk.length)
          grown.set(file.bytes)
          file.bytes = grown
        }
        file.bytes.set(chunk, at)
        return chunk.length
      },
      read: (buffer: ArrayBufferView, options?: { at?: number }) => {
        const at = options?.at ?? 0
        const view = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
        const n = Math.max(0, Math.min(view.length, file.bytes.length - at))
        if (n > 0) view.set(file.bytes.subarray(at, at + n))
        return n
      },
      flush: () => {},
      close: () => {
        file.open = false
      },
    }
  }

  async getFile() {
    if (this.file.jammed) {
      throw new DOMException(`${this.name} is locked`, 'NoModificationAllowedError')
    }
    return { size: this.file.bytes.length, name: this.name }
  }
}

class FakeDirectoryHandle {
  readonly kind = 'directory'
  readonly children = new Map<string, FakeDirectoryHandle | FakeFileHandle>()
  readonly name: string

  constructor(name: string) {
    this.name = name
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    const found = this.children.get(name)
    if (found) {
      if (found.kind !== 'directory') {
        throw new DOMException(`${name} is a file`, 'TypeMismatchError')
      }
      return found
    }
    if (!options?.create) throw notFound(name)
    const dir = new FakeDirectoryHandle(name)
    this.children.set(name, dir)
    return dir
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    const found = this.children.get(name)
    if (found) {
      if (found.kind !== 'file') throw new DOMException(`${name} is a directory`, 'TypeMismatchError')
      return found
    }
    if (!options?.create) throw notFound(name)
    const handle = new FakeFileHandle(name, { bytes: new Uint8Array(0), open: false, jammed: false })
    this.children.set(name, handle)
    return handle
  }

  async removeEntry(name: string) {
    const found = this.children.get(name)
    if (!found) throw notFound(name)
    if (found.kind === 'file' && found.file.open) {
      throw new DOMException(`${name} has an open access handle`, 'NoModificationAllowedError')
    }
    this.children.delete(name)
  }

  async *entries(): AsyncGenerator<[string, FakeDirectoryHandle | FakeFileHandle]> {
    for (const entry of [...this.children.entries()]) yield entry
  }
}

export interface FakeOpfs {
  /** Empties the tree. Pair with `opfsVfs.closeOpfs()` for a clean slate between tests. */
  reset(): void
  /** Puts bytes at `path`, creating parent directories — a file this session never opened. */
  write(path: string, bytes: Uint8Array | number): void
  /** The bytes at `path`, or `null` if there is no such file. */
  read(path: string): Uint8Array | null
  /** Every file path in the tree, sorted. */
  paths(): string[]
  /** Whether a directory exists — for asserting a read-only peek created nothing. */
  hasDirectory(path: string): boolean
  /** Makes `getFile()` on `path` fail, standing in for a second tab holding the file. */
  jam(path: string): void
}

/**
 * Installs the fake on `globalThis` and returns the handle to drive it with.
 *
 * Call once at module scope in a test file, before anything reaches OPFS. `navigator` is a
 * getter on Node's global object, so it has to be replaced with `defineProperty` rather than
 * assigned; `self` and `isSecureContext` do not exist in Node at all, and `opfsVfs`'s
 * `assertOpfsAvailable` checks all three before it will touch storage.
 */
export function installFakeOpfs(): FakeOpfs {
  let root = new FakeDirectoryHandle('')

  const storage = { getDirectory: async () => root }
  Object.defineProperty(globalThis, 'navigator', { value: { storage }, configurable: true })
  Object.defineProperty(globalThis, 'self', { value: globalThis, configurable: true })
  Object.defineProperty(globalThis, 'isSecureContext', { value: true, configurable: true })
  Object.defineProperty(globalThis, 'FileSystemFileHandle', {
    value: FakeFileHandle,
    configurable: true,
  })

  const parts = (path: string) => path.split('/').filter(Boolean)

  function directory(path: string, create: boolean): FakeDirectoryHandle | null {
    let dir = root
    for (const part of parts(path).slice(0, -1)) {
      let next = dir.children.get(part)
      if (!next) {
        if (!create) return null
        next = new FakeDirectoryHandle(part)
        dir.children.set(part, next)
      }
      if (next.kind !== 'directory') return null
      dir = next
    }
    return dir
  }

  function fileAt(path: string): FakeFileHandle | null {
    const dir = directory(path, false)
    const name = parts(path).at(-1) ?? ''
    const found = dir?.children.get(name)
    return found && found.kind === 'file' ? found : null
  }

  function walk(dir: FakeDirectoryHandle, prefix: string, out: string[]): void {
    for (const [name, child] of dir.children) {
      if (child.kind === 'file') out.push(`${prefix}/${name}`)
      else walk(child, `${prefix}/${name}`, out)
    }
  }

  return {
    reset() {
      root = new FakeDirectoryHandle('')
    },
    write(path, bytes) {
      const dir = directory(path, true)
      if (!dir) throw new Error(`cannot create ${path}`)
      const name = parts(path).at(-1) ?? ''
      const content = typeof bytes === 'number' ? new Uint8Array(bytes).fill(7) : bytes
      dir.children.set(name, new FakeFileHandle(name, { bytes: content, open: false, jammed: false }))
    },
    read(path) {
      return fileAt(path)?.file.bytes ?? null
    },
    paths() {
      const out: string[] = []
      walk(root, '', out)
      return out.sort()
    },
    hasDirectory(path) {
      let dir: FakeDirectoryHandle = root
      for (const part of parts(path)) {
        const next = dir.children.get(part)
        if (!next || next.kind !== 'directory') return false
        dir = next
      }
      return true
    },
    jam(path) {
      const handle = fileAt(path)
      if (!handle) throw new Error(`no such file ${path}`)
      handle.file.jammed = true
    },
  }
}
