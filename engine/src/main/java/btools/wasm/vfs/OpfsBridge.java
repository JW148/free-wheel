package btools.wasm.vfs;

import org.teavm.jso.JSObject;
import org.teavm.jso.typedarrays.Int8Array;

/**
 * The synchronous JS surface that {@link OpfsVirtualFileSystem} sits on top of.
 * <p>
 * TeaVM's {@link org.teavm.runtime.fs.VirtualFileSystem} SPI is entirely synchronous,
 * while every OPFS <em>opening</em> operation — {@code getDirectoryHandle},
 * {@code getFileHandle}, {@code createSyncAccessHandle} — returns a Promise. There is no
 * way to await a Promise from synchronous Java.
 * <p>
 * So the split is: JavaScript does all the async work up front (walk the directory tree,
 * open a {@code FileSystemSyncAccessHandle} per file, record sizes), and then exposes
 * only these synchronous methods. {@code FileSystemSyncAccessHandle.read()} is genuinely
 * synchronous, which is what makes this possible at all — and it is Worker-only on iOS,
 * which is why the engine has to live in a Worker regardless of anything else.
 * <p>
 * Implemented by {@code web/src/engine/opfsVfs.ts}, installed on {@code globalThis}.
 */
public interface OpfsBridge extends JSObject {

  boolean exists(String path);

  boolean isFile(String path);

  boolean isDirectory(String path);

  /**
   * @return file size in bytes, or -1 if absent. The SPI uses {@code int}, capping files at
   *         2 GB; the largest segment tile is ~250 MB, so this is not a practical limit.
   */
  int size(String path);

  /**
   * Must be <strong>stable</strong> for a given file across calls.
   * <p>
   * {@code ProfileCache} invalidates on {@code File.lastModified()}, so a value that moves
   * — a wall clock, or OPFS's own mtime after a rewrite — makes it re-parse the profile on
   * every route instead of caching it.
   */
  double lastModified(String path);

  /**
   * Directory entries as a newline-separated string, empty if none.
   * <p>
   * Returned as a string rather than an array to keep one marshalling style at this
   * boundary; directory listings are rare and tiny in the routing path.
   */
  String list(String path);

  /**
   * Reads up to {@code length} bytes from {@code position}.
   *
   * @return the bytes actually read — possibly shorter than requested at end of file, and
   *         empty past the end
   */
  Int8Array read(String path, int position, int length);
}
