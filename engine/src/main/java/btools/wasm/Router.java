package btools.wasm;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.List;

import btools.util.Crc32;

import btools.router.FormatGpx;
import btools.router.OsmNodeNamed;
import btools.router.OsmTrack;
import btools.router.RoutingContext;
import btools.router.RoutingEngine;
import btools.router.RoutingParamCollector;

import org.teavm.jso.JSExport;

/**
 * The Phase 1 routing entry point: BRouter's real {@link RoutingEngine}, driven from JS.
 * <p>
 * Mirrors the Android caller (`BRouterWorker.java:144-146`), which is the canonical
 * minimal shape — {@code outfileBase} and {@code logfileBase} are {@code null} so
 * nothing is written to disk and {@code infoLogEnabled} stays false, which is also what
 * keeps {@code StackSampler} from ever starting.
 * <p>
 * All I/O lands on whatever {@link org.teavm.runtime.fs.VirtualFileSystem} is registered,
 * so the caller must install one (and populate it) before calling {@link #route}.
 * Paths are absolute within that filesystem:
 * <ul>
 *   <li>{@code /profiles2/<name>.brf} — profile; {@code lookups.dat} is resolved from
 *       the same directory by BRouter itself</li>
 *   <li>{@code /segments4/<tile>.rd5} — routing data</li>
 * </ul>
 * Strings in, string out: {@code double[]} would not survive the JS boundary cleanly, and
 * BRouter already parses the {@code lonlats} URL format itself.
 */
public final class Router {

  private static final String PROFILE_DIR = "/profiles2";
  private static final String SEGMENT_DIR = "/segments4";

  /** Android clamps this 16–256; the iOS budget is roughly 300–450 MB. */
  private static final int MEMORY_CLASS = 128;

  private static final long MAX_RUNNING_TIME_MS = 60_000;

  private Router() {
  }

  /**
   * Computes a route and returns it as GPX, reading from the registered virtual
   * filesystem at the fixed OPFS layout.
   *
   * @param profile a profile name such as {@code trekking}, without the {@code .brf}
   * @param lonLats waypoints in BRouter's URL format: {@code lon,lat|lon,lat|…}
   *                (semicolons also accepted), in degrees
   * @return the GPX document, or a string starting {@code error:} — returning the failure
   *         rather than throwing keeps it legible across the JS boundary instead of
   *         surfacing as an opaque Wasm trap
   */
  @JSExport
  public static String route(String profile, String lonLats) {
    return routeIn(PROFILE_DIR, SEGMENT_DIR, profile, lonLats);
  }

  /**
   * The actual routing call, with the two directories injected.
   * <p>
   * Exists so the JVM reference build (see {@code JvmRouteMain}) drives <em>this same
   * method</em> against the real filesystem. Byte-identical GPX between JVM and Wasm only
   * means something if both sides run identical code; a separate JVM harness that
   * reimplemented the setup could agree with itself while diverging from the browser.
   *
   * @param profileDir directory holding {@code <profile>.brf} and {@code lookups.dat}
   * @param segmentDir directory holding the {@code .rd5} tiles
   */
  public static String routeIn(String profileDir, String segmentDir, String profile, String lonLats) {
    try {
      RoutingContext rc = new RoutingContext();
      // lookups.dat is resolved by BRouter from this file's parent directory.
      rc.localFunction = profileDir + "/" + profile + ".brf";
      rc.memoryclass = MEMORY_CLASS;

      RoutingParamCollector paramCollector = new RoutingParamCollector();
      List<OsmNodeNamed> waypoints = paramCollector.getWayPointList(lonLats);

      RoutingEngine engine = new RoutingEngine(
        null, null, new File(segmentDir), waypoints, rc,
        RoutingEngine.BROUTER_ENGINEMODE_ROUTING);
      engine.quite = true;          // suppresses System.out
      engine.doRun(MAX_RUNNING_TIME_MS);  // synchronous; despite extending Thread

      if (engine.getErrorMessage() != null) {
        return "error:" + engine.getErrorMessage();
      }

      OsmTrack track = engine.getFoundTrack();
      if (track == null) {
        return "error:no track found";
      }

      return new FormatGpx(rc).format(track);
    } catch (Throwable t) {
      return "error:" + t.getClass().getName() + ": " + t.getMessage();
    }
  }

  /**
   * CRC-32 of a string's UTF-8 bytes, using BRouter's own {@link btools.util.Crc32}.
   * <p>
   * The parity check needs a digest computable identically on both sides. Web Crypto is
   * unsuitable: {@code crypto.subtle} is secure-context-only and so absent over the plain
   * HTTP used for LAN device testing. Running the same Java CRC on both sides sidesteps
   * that entirely and cannot disagree by construction.
   */
  @JSExport
  public static int crc32Utf8(String text) {
    byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
    return Crc32.crc(bytes, 0, bytes.length);
  }

  /** Byte length of a string's UTF-8 encoding, so a mismatch reports size as well as CRC. */
  @JSExport
  public static int utf8Length(String text) {
    return text.getBytes(StandardCharsets.UTF_8).length;
  }
}
