/// <reference lib="webworker" />

/**
 * OPFS provisioning and the synchronous bridge that `OpfsVirtualFileSystem` (Java) reads
 * through.
 *
 * The division of labour is forced by the APIs: TeaVM's `VirtualFileSystem` SPI is entirely
 * synchronous, while every OPFS *opening* call returns a Promise. So everything async —
 * walking directories, downloading, opening `FileSystemSyncAccessHandle`s — happens here,
 * up front. Afterwards `globalThis.freeWheelVfs` answers questions synchronously and the
 * engine can run without ever awaiting.
 *
 * Worker-only: `createSyncAccessHandle()` has been Worker-only on iOS since 15.2.
 */

/** Minimal local typings — `FileSystemSyncAccessHandle` is absent from older TS DOM libs. */
export interface SyncAccessHandle {
  read(buffer: ArrayBufferView, options?: { at?: number }): number
  write(buffer: ArrayBufferView, options?: { at?: number }): number
  getSize(): number
  truncate(size: number): void
  flush(): void
  close(): void
}

interface FileHandleWithSync extends FileSystemFileHandle {
  createSyncAccessHandle(): Promise<SyncAccessHandle>
}

export interface AssetSpec {
  /** Absolute path inside OPFS, e.g. `/segments4/W5_N50.rd5`. */
  path: string
  /** Where to fetch it from if OPFS does not already have it. */
  url: string
  /**
   * Expected size in bytes, when known. Used to decide whether an existing file is
   * complete: without it, a download interrupted halfway looks like a valid file and the
   * engine fails later with a confusing decode error instead of re-fetching.
   */
  bytes?: number
}

export interface ProvisionProgress {
  path: string
  received: number
  total: number
  /** `skipped` when OPFS already held a complete copy. */
  state: 'downloading' | 'done' | 'skipped'
}

interface FileEntry {
  handle: SyncAccessHandle
  size: number
  /**
   * The size this path must reach before the VFS bridge will treat it as present — set while a
   * write to it is in flight, in-memory only.
   *
   * This is the same-session complement to `partials.isTruncated`, which protects a *fresh*
   * worker from ever opening (and thereby registering) a file an interrupted download left
   * short. Once a path is already open here, though, a failed or still-running write must not
   * let the bridge keep answering with whatever size the entry had before that write started —
   * on a file that previously held a full, different segment, that is a stale, too-large size
   * over bytes a resumed download truncated and only partly rewrote, and BRouter would read
   * past what is really there into whatever the rest of the file used to be.
   *
   * Deliberately does not touch, close, or remove the handle: a resume already in flight, or
   * about to retry, still needs it. And nothing has to explicitly clear this once the write
   * finishes — `isPending` compares against the entry's live `size`, so a `refreshSize` call
   * that brings `size` up to `targetSize` resolves it on its own.
   */
  targetSize?: number
}

function isPending(entry: FileEntry): boolean {
  return entry.targetSize !== undefined && entry.size < entry.targetSize
}

/**
 * A single fixed timestamp for every file.
 *
 * `ProfileCache` invalidates on `File.lastModified()`, so this must not move between calls
 * or the profile is re-parsed on every route. A constant is the strongest guarantee. The
 * trade-off is that replacing a profile in OPFS will not invalidate the cache within a
 * session — acceptable because provisioning happens once at startup, before any routing.
 */
const FIXED_MTIME = 1_000

const files = new Map<string, FileEntry>()
const directories = new Set<string>(['/'])

/** Grown as needed and reused across reads — see `read` below for why that is safe. */
let scratch = new Uint8Array(1 << 16)

function normalise(path: string): string {
  const parts: string[] = []
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  return '/' + parts.join('/')
}

function registerDirectories(filePath: string): void {
  const parts = filePath.split('/').filter(Boolean)
  parts.pop() // drop the filename
  let current = ''
  for (const part of parts) {
    current += '/' + part
    directories.add(current)
  }
}

/**
 * Checks OPFS is actually reachable, with a message that names the cause.
 *
 * `navigator.storage` is `[SecureContext]`, so on a plain-HTTP origin it is not merely
 * restricted — it is `undefined`, and reaching for `getDirectory()` throws an opaque
 * "undefined is not an object". Worth its own error: the fix (serve over HTTPS) is nothing
 * like what that TypeError suggests.
 */
export function assertOpfsAvailable(): void {
  if (!self.isSecureContext) {
    throw new Error(
      'OPFS needs a secure context, and this page was served over plain HTTP. ' +
        'navigator.storage is [SecureContext], so it does not exist here. ' +
        'Serve the app over HTTPS (see README — local CA or a tunnel).',
    )
  }
  if (typeof navigator.storage?.getDirectory !== 'function') {
    throw new Error(
      'navigator.storage.getDirectory is unavailable even though this is a secure context — ' +
        'OPFS requires iOS 15.2+.',
    )
  }
  if (typeof FileSystemFileHandle === 'undefined') {
    throw new Error('FileSystemFileHandle is unavailable — OPFS is not supported here.')
  }
}

async function directoryFor(path: string): Promise<FileSystemDirectoryHandle> {
  const parts = path.split('/').filter(Boolean)
  parts.pop()
  let dir = await navigator.storage.getDirectory()
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true })
  }
  return dir
}

/**
 * Opens (creating if absent) a file in OPFS and registers its handle.
 *
 * All handles must come from here. OPFS permits only **one** open sync access handle per
 * file, so the engine's VFS and the tile downloader cannot each open their own — the second
 * would fail. Sharing one registry is what lets a tile be downloaded and then routed against
 * without closing anything in between.
 */
/**
 * Opens in flight, keyed by path.
 *
 * Two callers asking for the same file concurrently must not both reach
 * `createSyncAccessHandle()` — OPFS permits exactly one open handle per file, so the second
 * throws `InvalidStateError: Access Handles cannot be created...`. The `files` cache alone
 * cannot prevent it, because neither call has populated it yet while both are still awaiting.
 *
 * This is not hypothetical: the startup check and the map controller both ask the engine what
 * is installed as the app boots, and the collision made a fully provisioned app report that
 * it had no data at all.
 */
const opening = new Map<string, Promise<SyncAccessHandle>>()

/**
 * Opens a sync access handle, retrying briefly if one is still held elsewhere.
 *
 * A page reload overlaps: the outgoing page's Worker is torn down asynchronously and its
 * handles can outlive it by a few tens of milliseconds, so the incoming page's first attempt
 * loses with `InvalidStateError`. That is transient and clears itself, and refusing to start
 * because of it turns an ordinary refresh into a broken app.
 *
 * It does **not** paper over the real conflict: a second tab holds its handles indefinitely,
 * so the retries run out and the error surfaces, which is the honest outcome — nothing the
 * app can do about that one but say so.
 */
async function openWithRetry(
  fileHandle: FileHandleWithSync,
  path: string,
): Promise<SyncAccessHandle> {
  const delays = [0, 60, 120, 240, 400]
  let last: unknown
  for (const delay of delays) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
    try {
      return await fileHandle.createSyncAccessHandle()
    } catch (error) {
      last = error
      if (!(error instanceof DOMException) || error.name !== 'InvalidStateError') throw error
    }
  }
  throw new Error(
    `${path} is already open elsewhere — free-wheel can only run in one tab at a time. ` +
      `Close the others and reload. (${last instanceof Error ? last.message : String(last)})`,
  )
}

export function openHandle(path: string): Promise<SyncAccessHandle> {
  assertOpfsAvailable()
  const key = normalise(path)

  const existing = files.get(key)
  if (existing) return Promise.resolve(existing.handle)

  const inFlight = opening.get(key)
  if (inFlight) return inFlight

  const attempt = (async () => {
    const dir = await directoryFor(key)
    const name = key.slice(key.lastIndexOf('/') + 1)
    const fileHandle = (await dir.getFileHandle(name, { create: true })) as FileHandleWithSync
    const handle = await openWithRetry(fileHandle, key)

    files.set(key, { handle, size: handle.getSize() })
    registerDirectories(key)
    return handle
  })()

  opening.set(key, attempt)
  // Cleared either way: a failed open must not poison every later attempt on that path.
  return attempt.finally(() => opening.delete(key))
}

/**
 * Closes a file's handle and removes it from OPFS.
 *
 * The close must happen first and the registry entry must go with it: an open sync access
 * handle blocks `removeEntry` with `NoModificationAllowedError`, and a stale registry entry
 * would leave the VFS reporting a file that is no longer there.
 */
export async function removeFile(path: string): Promise<void> {
  const key = normalise(path)

  const entry = files.get(key)
  if (entry) {
    entry.handle.close()
    files.delete(key)
  }

  const dir = await directoryFor(key)
  const name = key.slice(key.lastIndexOf('/') + 1)
  try {
    await dir.removeEntry(name)
  } catch (error) {
    if ((error as DOMException)?.name !== 'NotFoundError') throw error
  }
}

/**
 * Names of the files directly inside an OPFS directory.
 *
 * Names only, deliberately: reading size or mtime means `getFile()`, whose behaviour on a file
 * holding an open sync access handle (an exclusive lock) is not worth depending on. Sizes come
 * from the handles instead.
 */
export async function listDirectoryEntries(dirPath: string): Promise<string[]> {
  assertOpfsAvailable()
  const key = normalise(dirPath)
  const parts = key.split('/').filter(Boolean)

  let dir = await navigator.storage.getDirectory()
  for (const part of parts) {
    try {
      dir = await dir.getDirectoryHandle(part)
    } catch {
      return [] // directory not created yet
    }
  }

  const names: string[] = []
  for await (const [name, handle] of (
    dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }
  ).entries()) {
    if (handle.kind === 'file') names.push(name)
  }
  return names.sort()
}

/**
 * Reads a byte range from an already-open OPFS file into a fresh buffer.
 *
 * A fresh buffer rather than the shared scratch: the result is transferred to another thread,
 * and transferring the scratch would detach it out from under the VFS.
 *
 * @throws if the file is not open — callers must have opened it via {@link openHandle}
 */
export function readRangeFromOpfs(path: string, offset: number, length: number): ArrayBuffer {
  const key = normalise(path)
  const entry = files.get(key)
  if (!entry) throw new Error(`${key} is not open`)

  const clamped = Math.max(0, Math.min(length, entry.size - offset))
  const view = new Uint8Array(clamped)
  if (clamped > 0) entry.handle.read(view, { at: offset })
  return view.buffer
}

/** Re-reads a file's size into the registry after it has been written to. */
export function refreshSize(path: string): number {
  const key = normalise(path)
  const entry = files.get(key)
  if (!entry) return -1
  entry.size = entry.handle.getSize()
  return entry.size
}

export function knownSize(path: string): number {
  return files.get(normalise(path))?.size ?? -1
}

/**
 * Marks `path` as not yet reaching `bytes`, so the VFS bridge treats it as absent until its
 * real size catches up. See `FileEntry.targetSize` for why this is what the same-session half
 * of an interrupted download needs, and why nothing needs to explicitly clear it again.
 *
 * A no-op if the path isn't open yet — nothing to mark, and a caller that hasn't opened it
 * couldn't be about to write to it either.
 */
export function markPending(path: string, bytes: number): void {
  const entry = files.get(normalise(path))
  if (entry) entry.targetSize = bytes
}

/**
 * Walks down to a path's parent directory without creating anything along the way.
 *
 * Deliberately distinct from `directoryFor`, which passes `{ create: true }` because callers
 * that reach it are about to write. `peekFileSize` is a read-only glance — a path that doesn't
 * exist yet should stay that way, not get a directory created as a side effect of asking about
 * it. Returns `null` if any segment of the path is missing.
 */
async function directoryForPeek(path: string): Promise<FileSystemDirectoryHandle | null> {
  const parts = path.split('/').filter(Boolean)
  parts.pop()
  let dir = await navigator.storage.getDirectory()
  for (const part of parts) {
    try {
      dir = await dir.getDirectoryHandle(part)
    } catch {
      return null
    }
  }
  return dir
}

/**
 * The size of a file that might not be open yet, without opening — and thereby registering —
 * it.
 *
 * `listDirectoryEntries` deliberately avoids `getFile()` because its behaviour is unreliable on
 * a file that already holds an open sync access handle elsewhere — but that caveat only
 * applies to a path already in the registry, and this checks the registry first and answers
 * from it directly in that case. For everything else — typically an orphan left by a session
 * that crashed or was killed mid-download, discovered fresh after a restart with nothing yet
 * open on it — a `getFile()` peek is safe, and lets a caller decide whether a file is worth
 * opening (and thereby exposing to the VFS bridge as present) at all before doing so.
 *
 * Returns -1 only for genuine absence — no such directory, no such file. Anything else that
 * stops `getFile()` from answering (a second tab holding an incompatible lock, say) is a real
 * error and is thrown rather than folded into "-1 means absent": conflating the two would make
 * `isTruncated` (the only caller) silently drop a merely-locked, perfectly good tile out of
 * `installedTiles()` instead of surfacing the same honest "already open elsewhere" failure the
 * rest of this module raises for that scenario.
 */
export async function peekFileSize(path: string): Promise<number> {
  const key = normalise(path)
  const cached = files.get(key)
  if (cached) return cached.size

  const dir = await directoryForPeek(key)
  if (!dir) return -1
  const name = key.slice(key.lastIndexOf('/') + 1)

  let fileHandle: FileSystemFileHandle
  try {
    fileHandle = await dir.getFileHandle(name)
  } catch {
    return -1 // no such file
  }

  try {
    const file = await fileHandle.getFile()
    return file.size
  } catch (error) {
    throw new Error(
      `${path} could not be sized, and is likely open elsewhere — free-wheel can only run in ` +
        `one tab at a time. (${error instanceof Error ? error.message : String(error)})`,
    )
  }
}

/**
 * Ensures every asset is present in OPFS, downloading what is missing, and leaves a sync
 * access handle open for each.
 *
 * Handles are deliberately kept open rather than closed and reopened: a file may only have
 * one open sync handle at a time, and acquiring one is async, so a synchronous `read()`
 * could never reopen it.
 */
export async function provisionOpfs(
  assets: AssetSpec[],
  onProgress?: (progress: ProvisionProgress) => void,
): Promise<void> {
  assertOpfsAvailable()

  for (const asset of assets) {
    const path = normalise(asset.path)

    // Reuse an already-open handle across repeated mounts in one worker.
    const existing = files.get(path)
    if (existing && (asset.bytes === undefined || existing.size === asset.bytes)) {
      onProgress?.({ path, received: existing.size, total: existing.size, state: 'skipped' })
      continue
    }

    const dir = await directoryFor(path)
    const name = path.slice(path.lastIndexOf('/') + 1)
    const fileHandle = (await dir.getFileHandle(name, { create: true })) as FileHandleWithSync
    const handle = existing?.handle ?? (await fileHandle.createSyncAccessHandle())

    const currentSize = handle.getSize()
    const complete =
      asset.bytes !== undefined ? currentSize === asset.bytes : currentSize > 0

    if (complete) {
      files.set(path, { handle, size: currentSize })
      registerDirectories(path)
      onProgress?.({ path, received: currentSize, total: currentSize, state: 'skipped' })
      continue
    }

    // Stream rather than buffer: the segment tiles run to hundreds of megabytes, and
    // response.arrayBuffer() on a 137 MB file is a needless spike on a phone.
    const response = await fetch(asset.url)
    if (!response.ok || !response.body) {
      handle.close()
      files.delete(path)
      throw new Error(`could not fetch ${asset.url} (${response.status})`)
    }
    const total = asset.bytes ?? Number(response.headers.get('content-length') ?? 0)

    handle.truncate(0)
    let offset = 0
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      handle.write(value, { at: offset })
      offset += value.byteLength
      onProgress?.({ path, received: offset, total, state: 'downloading' })
    }
    handle.flush()

    if (asset.bytes !== undefined && offset !== asset.bytes) {
      handle.close()
      files.delete(path)
      throw new Error(`${path}: expected ${asset.bytes} bytes, wrote ${offset}`)
    }

    files.set(path, { handle, size: handle.getSize() })
    registerDirectories(path)
    onProgress?.({ path, received: offset, total: offset || total, state: 'done' })
  }
}

/**
 * Installs the synchronous surface `OpfsVirtualFileSystem` looks for on `globalThis`.
 * Method names must match {@code btools.wasm.vfs.OpfsBridge} exactly.
 */
export function installVfsBridge(): void {
  const bridge = {
    // Every lookup below treats a `targetSize`-pending entry (see `FileEntry.targetSize`) as
    // though it doesn't exist — the same-session complement to `partials.isTruncated` keeping
    // a cross-restart orphan out of the registry in the first place.
    exists(path: string): boolean {
      const key = normalise(path)
      const entry = files.get(key)
      if (entry && isPending(entry)) return false
      return files.has(key) || directories.has(key)
    },

    isFile(path: string): boolean {
      const entry = files.get(normalise(path))
      return !!entry && !isPending(entry)
    },

    isDirectory(path: string): boolean {
      return directories.has(normalise(path))
    },

    size(path: string): number {
      const entry = files.get(normalise(path))
      if (!entry || isPending(entry)) return -1
      return entry.size
    },

    lastModified(_path: string): number {
      return FIXED_MTIME
    },

    list(path: string): string {
      const prefix = normalise(path)
      const base = prefix === '/' ? '/' : prefix + '/'
      const names = new Set<string>()

      for (const candidate of [...files.keys(), ...directories]) {
        if (candidate === prefix || !candidate.startsWith(base)) continue
        const entry = files.get(candidate)
        if (entry && isPending(entry)) continue
        const rest = candidate.slice(base.length)
        const head = rest.split('/')[0]
        if (head) names.add(head)
      }
      return [...names].join('\n')
    },

    /**
     * Reads into a reused scratch buffer and returns a view of it.
     *
     * Safe because the Java side (`OpfsVirtualFileAccessor.read`) copies out via
     * `copyToJavaArray()` synchronously, before any further read can occur — there is no
     * await anywhere in this path. Reusing the buffer matters: a 137 MB tile is read in
     * thousands of chunks, and allocating each one would make the GC do the work instead.
     */
    read(path: string, position: number, length: number): Int8Array {
      const entry = files.get(normalise(path))
      if (!entry || isPending(entry) || length <= 0 || position >= entry.size) {
        return new Int8Array(0)
      }

      if (scratch.byteLength < length) {
        scratch = new Uint8Array(Math.max(length, scratch.byteLength * 2))
      }

      const view = new Uint8Array(scratch.buffer, 0, length)
      const read = entry.handle.read(view, { at: position })
      return new Int8Array(scratch.buffer, 0, read)
    },
  }

  ;(globalThis as unknown as { freeWheelVfs: unknown }).freeWheelVfs = bridge
}

/** Frees every open handle. Only needed for teardown in tests. */
export function closeOpfs(): void {
  for (const { handle } of files.values()) handle.close()
  files.clear()
  opening.clear()
  directories.clear()
  directories.add('/')
}

/** Bytes currently held, by path — for surfacing real usage rather than a fuzzed estimate. */
export function provisionedFiles(): { path: string; size: number }[] {
  return [...files.entries()].map(([path, { size }]) => ({ path, size }))
}
