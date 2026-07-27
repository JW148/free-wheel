package btools.wasm;

import java.io.File;
import java.io.FileOutputStream;
import java.io.RandomAccessFile;

import btools.util.Crc32;

import org.teavm.jso.JSExport;
import org.teavm.runtime.fs.VirtualFileSystemProvider;
import org.teavm.runtime.fs.memory.InMemoryVirtualFileSystem;

/**
 * Phase 1 gate: does {@link RandomAccessFile} actually work on the WasmGC backend,
 * routed through a pluggable {@link org.teavm.runtime.fs.VirtualFileSystem}?
 * <p>
 * The entire no-fork strategy rests on this. BRouter's whole disk-read surface is
 * five {@code seek()} + {@code readFully()} calls (OsmFile, PhysicalFile), and TeaVM
 * implements {@code TRandomAccessFile} on top of
 * {@code TFile.findVirtualFile() -> VirtualFile.createAccessor() -> VirtualFileAccessor}.
 * If that chain survives translation to WasmGC, BRouter compiles unmodified and an
 * OPFS-backed {@code VirtualFileSystem} is all that is needed. If it does not, the plan
 * needs rethinking before any more of it is built.
 * <p>
 * Deliberately uses TeaVM's own {@link InMemoryVirtualFileSystem} rather than a
 * hand-rolled one, so a failure here means "the backend cannot do this" and not
 * "my filesystem implementation is wrong". The OPFS implementation comes after this
 * passes.
 * <p>
 * Reachable only via {@code preservedClasses} in build.gradle — nothing calls it from
 * {@link SpikeMain#main}.
 */
public final class VfsProbe {

  /** Mirrors the shape of a .rd5 read: a header, then a seek to an interior record. */
  private static final int FILE_SIZE = 8192;
  private static final int RECORD_OFFSET = 4096;
  private static final int RECORD_LENGTH = 1024;

  private VfsProbe() {
  }

  /**
   * Writes a deterministic file, reads an interior slice back via seek + readFully,
   * and returns a description of what happened.
   *
   * @return {@code "ok:<crc>:<length>"} on success, or {@code "error:<detail>"} — the
   *         string form keeps the failure visible in the browser instead of surfacing
   *         as an opaque Wasm trap.
   */
  @JSExport
  public static String probe() {
    try {
      VirtualFileSystemProvider.setInstance(new InMemoryVirtualFileSystem());

      byte[] written = deterministicBytes(FILE_SIZE);
      try (FileOutputStream out = new FileOutputStream("/probe.bin")) {
        out.write(written);
      }

      // Exactly BRouter's access pattern: open, length, seek, readFully, close.
      byte[] slice = new byte[RECORD_LENGTH];
      long reportedLength;
      try (RandomAccessFile raf = new RandomAccessFile("/probe.bin", "r")) {
        reportedLength = raf.length();
        raf.seek(RECORD_OFFSET);
        raf.readFully(slice);
      }

      if (reportedLength != FILE_SIZE) {
        return "error:length was " + reportedLength + ", expected " + FILE_SIZE;
      }

      // Confirm we read the bytes we meant to, not just *some* bytes — a VFS that
      // ignored seek() would still return data of the right length.
      for (int i = 0; i < RECORD_LENGTH; i++) {
        if (slice[i] != written[RECORD_OFFSET + i]) {
          return "error:byte " + i + " was " + slice[i] + ", expected " + written[RECORD_OFFSET + i];
        }
      }

      return "ok:" + Crc32.crc(slice, 0, slice.length) + ":" + reportedLength;
    } catch (Throwable t) {
      return "error:" + t.getClass().getName() + ": " + t.getMessage();
    }
  }

  /** Also worth knowing: does {@code java.io.File} metadata survive translation? */
  @JSExport
  public static String probeFileMetadata() {
    try {
      VirtualFileSystemProvider.setInstance(new InMemoryVirtualFileSystem());
      try (FileOutputStream out = new FileOutputStream("/meta.bin")) {
        out.write(deterministicBytes(64));
      }

      File file = new File("/meta.bin");
      // ProfileCache invalidates on lastModified(), so a VFS returning 0 or a moving
      // value would make cache invalidation thrash. Confirm it is at least readable.
      return "ok:exists=" + file.exists()
        + ":isFile=" + file.isFile()
        + ":length=" + file.length()
        + ":lastModified=" + file.lastModified();
    } catch (Throwable t) {
      return "error:" + t.getClass().getName() + ": " + t.getMessage();
    }
  }

  /**
   * Reads a file through {@link RandomAccessFile} on whatever filesystem is currently
   * registered and reports what came back.
   * <p>
   * Isolates "is the VFS returning the right bytes" from "does BRouter behave correctly on
   * them" — the two failure modes look identical from the outside, and a decoder fed subtly
   * wrong data fails in ways that point nowhere near the filesystem.
   *
   * @return {@code ok:<length>:<crc32>:<firstBytesHex>} or {@code error:…}
   */
  @JSExport
  public static String probeRead(String path) {
    try {
      File file = new File(path);
      if (!file.exists()) {
        return "error:does not exist: " + path;
      }

      int length = (int) file.length();
      byte[] all = new byte[length];
      try (RandomAccessFile raf = new RandomAccessFile(path, "r")) {
        raf.readFully(all);
      }

      StringBuilder head = new StringBuilder();
      for (int i = 0; i < Math.min(8, length); i++) {
        head.append(String.format("%02x", all[i] & 0xff));
      }
      return "ok:" + length + ":" + Crc32.crc(all, 0, length) + ":" + head;
    } catch (Throwable t) {
      return "error:" + t.getClass().getName() + ": " + t.getMessage();
    }
  }

  /** Directory listing through {@code java.io.File}, to check path resolution. */
  @JSExport
  public static String probeList(String path) {
    try {
      String[] names = new File(path).list();
      if (names == null) {
        return "error:not a directory: " + path;
      }
      return "ok:" + String.join(",", names);
    } catch (Throwable t) {
      return "error:" + t.getClass().getName() + ": " + t.getMessage();
    }
  }

  /**
   * Recurses exactly {@code depth} frames and returns the depth reached.
   * <p>
   * Exists to measure the usable Java call depth on a given runtime. It cannot report its
   * own limit, because stack exhaustion in WasmGC surfaces as a JS {@code RangeError} that
   * is not representable as a Java {@code Throwable} — so the caller raises {@code depth}
   * until this throws, and catches it in JavaScript.
   * <p>
   * That fact is the whole reason a limit is needed: {@code OsmNodesMap.cleanupPeninsulas}
   * relies on {@code catch (StackOverflowError)} to bound a deliberately unbounded graph
   * walk, and on WasmGC that catch can never fire.
   */
  @JSExport
  public static int probeDepth(int depth) {
    return recurse(depth, 0);
  }

  private static int recurse(int remaining, int depth) {
    if (remaining <= 0) {
      return depth;
    }
    // A little local state so the frame is not trivially small, making the measurement a
    // closer analogue of a real recursive method than an empty frame would be.
    int carried = depth ^ (remaining * 31);
    int result = recurse(remaining - 1, depth + 1);
    return result ^ (carried & 0);
  }

  private static byte[] deterministicBytes(int n) {
    byte[] bytes = new byte[n];
    int seed = 987654321;
    for (int i = 0; i < n; i++) {
      seed = seed * 1103515245 + 12345;
      bytes[i] = (byte) (seed >>> 16);
    }
    return bytes;
  }
}
