package btools.wasm.vfs;

import java.io.IOException;

import org.teavm.jso.typedarrays.Int8Array;
import org.teavm.runtime.fs.VirtualFileAccessor;

/**
 * A read cursor over one OPFS file.
 * <p>
 * This is the class BRouter's hot path actually goes through: every one of the five
 * {@code seek()} / {@code readFully()} calls in {@code OsmFile} and {@code PhysicalFile}
 * lands here via {@code TRandomAccessFile}.
 * <p>
 * Read-only by design. Nothing in the routing path writes — {@code outfileBase} and
 * {@code logfileBase} are always {@code null} — and provisioning OPFS is done from
 * JavaScript, where the async API is available. Write methods therefore throw rather than
 * silently no-op, so that if something ever does try to write, it says so.
 */
final class OpfsVirtualFileAccessor implements VirtualFileAccessor {

  private final OpfsBridge bridge;
  private final String path;
  private int position;

  OpfsVirtualFileAccessor(OpfsBridge bridge, String path) {
    this.bridge = bridge;
    this.path = path;
  }

  @Override
  public int read(byte[] buffer, int offset, int length) throws IOException {
    if (offset < 0 || length < 0 || offset + length > buffer.length) {
      throw new IndexOutOfBoundsException(
        "offset=" + offset + " length=" + length + " buffer=" + buffer.length);
    }
    if (length == 0) {
      return 0;
    }

    Int8Array chunk = bridge.read(path, position, length);
    int read = chunk.getLength();
    if (read <= 0) {
      return -1; // end of file, as InputStream/RandomAccessFile expect
    }

    // One copy across the boundary. Could be avoided with a view onto the Java array, but
    // the semantics of that are version-dependent and BRouter's reads are chunky enough
    // (KB to hundreds of KB) that the copy is not worth the fragility.
    byte[] bytes = chunk.copyToJavaArray();
    System.arraycopy(bytes, 0, buffer, offset, read);
    position += read;
    return read;
  }

  @Override
  public void write(byte[] buffer, int offset, int length) throws IOException {
    throw new IOException("read-only filesystem: cannot write " + path);
  }

  @Override
  public int tell() {
    return position;
  }

  @Override
  public void seek(int target) throws IOException {
    if (target < 0) {
      throw new IOException("negative seek on " + path + ": " + target);
    }
    // Deliberately permits seeking past the end, matching RandomAccessFile, where a
    // subsequent read simply reports end-of-file.
    position = target;
  }

  @Override
  public void skip(int count) throws IOException {
    seek(position + count);
  }

  @Override
  public int size() {
    return bridge.size(path);
  }

  @Override
  public void resize(int size) throws IOException {
    throw new IOException("read-only filesystem: cannot resize " + path);
  }

  @Override
  public void close() {
    // Sync access handles are owned by the JS side and stay open for the session: acquiring
    // one is async, so re-opening on demand is impossible from synchronous Java. BRouter
    // closes and reopens segment files freely, so closing the real handle here would make
    // the next read unserviceable.
  }

  @Override
  public void flush() {
    // Nothing buffered on this side.
  }
}
