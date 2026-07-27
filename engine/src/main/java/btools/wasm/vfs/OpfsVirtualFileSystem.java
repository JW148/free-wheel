package btools.wasm.vfs;

import java.util.ArrayDeque;
import java.util.Deque;

import org.teavm.jso.JSBody;
import org.teavm.jso.JSExport;
import org.teavm.runtime.fs.VirtualFile;
import org.teavm.runtime.fs.VirtualFileSystem;
import org.teavm.runtime.fs.VirtualFileSystemProvider;

/**
 * The heart of the port: a TeaVM {@link VirtualFileSystem} backed by OPFS, which is what
 * lets BRouter's {@code RandomAccessFile} I/O read {@code .rd5} tiles out of browser storage
 * with BRouter itself compiled <strong>unmodified</strong>.
 * <p>
 * Install once at worker startup, after JavaScript has provisioned OPFS and installed the
 * bridge:
 * <pre>
 *   // JS: await provisionOpfs(...); installVfsBridge();
 *   OpfsVirtualFileSystem.install();   // exported to JS as installOpfsVfs()
 * </pre>
 * <p>
 * Kept behind the {@link VirtualFileSystem} interface deliberately: the Capacitor escape
 * hatch in the plan is exactly "swap this one class for a native-filesystem-backed one", and
 * nothing above it — not the UI, not the Wasm engine — needs to know.
 */
public final class OpfsVirtualFileSystem implements VirtualFileSystem {

  private final OpfsBridge bridge;

  private OpfsVirtualFileSystem(OpfsBridge bridge) {
    this.bridge = bridge;
  }

  /**
   * Registers an OPFS-backed filesystem as the process-wide filesystem.
   *
   * @return {@code "ok"}, or {@code "error:…"} if JavaScript has not installed the bridge —
   *         returning rather than throwing keeps the failure legible across the JS boundary
   */
  @JSExport
  public static String installOpfsVfs() {
    OpfsBridge bridge = bridge();
    if (bridge == null) {
      return "error:globalThis.freeWheelVfs is not installed — call installVfsBridge() first";
    }
    VirtualFileSystemProvider.setInstance(new OpfsVirtualFileSystem(bridge));
    return "ok";
  }

  @JSBody(script = "return globalThis.freeWheelVfs || null;")
  private static native OpfsBridge bridge();

  /**
   * BRouter is always given absolute paths ({@code /profiles2/…}, {@code /segments4/…}), so
   * this only matters as the base for any stray relative path.
   */
  @Override
  public String getUserDir() {
    return "/";
  }

  @Override
  public VirtualFile getFile(String path) {
    return new OpfsVirtualFile(bridge, canonicalize(path));
  }

  @Override
  public boolean isWindows() {
    return false;
  }

  @Override
  public String[] getRoots() {
    return new String[]{"/"};
  }

  /**
   * Normalises a POSIX path: collapses duplicate separators, resolves {@code .} and
   * {@code ..}, and drops any trailing slash.
   * <p>
   * Done in Java rather than JS so the bridge only ever sees canonical keys, which keeps its
   * handle registry a plain map lookup instead of a path-matching exercise. It also has to be
   * right because {@code RoutingEngine} derives the profile directory via
   * {@code new File(rc.localFunction).getParentFile()}.
   */
  @Override
  public String canonicalize(String path) {
    boolean absolute = path.startsWith("/");
    Deque<String> parts = new ArrayDeque<>();

    for (String segment : path.split("/")) {
      if (segment.isEmpty() || ".".equals(segment)) {
        continue;
      }
      if ("..".equals(segment)) {
        if (!parts.isEmpty() && !"..".equals(parts.peekLast())) {
          parts.removeLast();
        } else if (!absolute) {
          parts.addLast("..");
        }
        continue;
      }
      parts.addLast(segment);
    }

    if (parts.isEmpty()) {
      return absolute ? "/" : "";
    }

    StringBuilder result = new StringBuilder();
    for (String part : parts) {
      result.append('/').append(part);
    }
    return absolute ? result.toString() : result.substring(1);
  }
}
