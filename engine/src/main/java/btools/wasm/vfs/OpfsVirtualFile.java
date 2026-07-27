package btools.wasm.vfs;

import java.io.IOException;

import org.teavm.runtime.fs.VirtualFile;
import org.teavm.runtime.fs.VirtualFileAccessor;

/**
 * One path in the OPFS tree, as TeaVM's {@code java.io.File} sees it.
 * <p>
 * Holds no handle of its own — every question is answered by asking {@link OpfsBridge}
 * about the path. That keeps this stateless and means a file appearing in OPFS after a
 * {@code VirtualFile} was created is still visible, which matters because provisioning and
 * routing are separate phases.
 */
final class OpfsVirtualFile implements VirtualFile {

  private final OpfsBridge bridge;
  private final String path;

  OpfsVirtualFile(OpfsBridge bridge, String path) {
    this.bridge = bridge;
    this.path = path;
  }

  @Override
  public String getName() {
    int slash = path.lastIndexOf('/');
    return slash < 0 ? path : path.substring(slash + 1);
  }

  @Override
  public boolean isDirectory() {
    return bridge.isDirectory(path);
  }

  @Override
  public boolean isFile() {
    return bridge.isFile(path);
  }

  @Override
  public boolean exists() {
    return bridge.exists(path);
  }

  @Override
  public String[] listFiles() {
    String joined = bridge.list(path);
    if (joined == null || joined.isEmpty()) {
      return new String[0];
    }
    return joined.split("\n");
  }

  @Override
  public VirtualFileAccessor createAccessor(boolean readable, boolean writable, boolean append) {
    if (writable || append) {
      return null; // signals "cannot open for writing" to the classlib
    }
    if (!bridge.isFile(path)) {
      return null;
    }
    return new OpfsVirtualFileAccessor(bridge, path);
  }

  @Override
  public boolean createFile(String name) throws IOException {
    throw new IOException("read-only filesystem: cannot create " + path + "/" + name);
  }

  @Override
  public boolean createDirectory(String name) {
    return false;
  }

  @Override
  public boolean delete() {
    return false;
  }

  @Override
  public boolean adopt(VirtualFile file, String name) {
    return false;
  }

  @Override
  public boolean canRead() {
    return bridge.exists(path);
  }

  @Override
  public boolean canWrite() {
    return false;
  }

  /**
   * @return a stable timestamp — see {@link OpfsBridge#lastModified}. {@code ProfileCache}
   *         keys off this, so it must not move between calls.
   */
  @Override
  public long lastModified() {
    return (long) bridge.lastModified(path);
  }

  @Override
  public boolean setLastModified(long lastModified) {
    return false;
  }

  @Override
  public boolean setReadOnly(boolean readOnly) {
    return readOnly; // already read-only; succeed iff that is what was asked for
  }

  @Override
  public int length() {
    int size = bridge.size(path);
    return size < 0 ? 0 : size;
  }
}
