package btools.wasm;

import btools.util.CheapRuler;
import btools.util.Crc32;
import btools.util.SortedHeap;

import btools.wasm.vfs.OpfsVirtualFileSystem;

import org.teavm.jso.JSExport;
import org.teavm.jso.JSExportClasses;

/**
 * Spike 1 entry point: proves Java -&gt; WasmGC -&gt; Web Worker -&gt; home-screen PWA
 * using genuinely representative BRouter compute and <em>no file I/O</em>.
 * <p>
 * The three exports are chosen to mean something rather than to be easy:
 * <ul>
 *   <li>{@link CheapRuler} — floating-point geodesics plus a 1800-entry static
 *       scale cache, so this exercises static initialisation and double maths.</li>
 *   <li>{@link SortedHeap} — the Dijkstra open set, and the hot data structure of
 *       the whole engine. Exercises object allocation and array churn under WasmGC.</li>
 *   <li>{@link Crc32} — tight integer/byte-array loop, the shape of the codec path.</li>
 * </ul>
 * Every kernel is deterministic, so the JVM and Wasm builds must agree exactly.
 * {@link JvmParityMain} runs these same methods on the JVM to produce the
 * reference values.
 */
@JSExportClasses({VfsProbe.class, Router.class, OpfsVirtualFileSystem.class})
public final class SpikeMain {

  private SpikeMain() {
  }

  public static void main(String[] args) {
    // TeaVM requires a main method; the real surface is the @JSExport methods.
  }

  // -------------------------------------------------------------------------
  // CheapRuler
  // -------------------------------------------------------------------------

  /**
   * Geodesic distance in metres between two WGS84 points given in degrees.
   * <p>
   * BRouter works in fixed-point micro-degrees internally
   * ({@code ilon = 180000000 + lon * 1e6}, {@code ilat = 90000000 + lat * 1e6});
   * the conversion happens here so the JS side can pass ordinary degrees.
   */
  @JSExport
  public static double distance(double lat1, double lon1, double lat2, double lon2) {
    return CheapRuler.distance(toIlon(lon1), toIlat(lat1), toIlon(lon2), toIlat(lat2));
  }

  /**
   * The same value as {@link #distance}, as the hex of its IEEE-754 bit pattern.
   * <p>
   * A JS number <em>is</em> a double, so comparing the decimal rendering across
   * runtimes is not quite a proof. This is, and it is the success criterion:
   * "exported results are bit-identical to the JVM".
   */
  @JSExport
  public static String distanceBits(double lat1, double lon1, double lat2, double lon2) {
    return Long.toHexString(Double.doubleToLongBits(distance(lat1, lon1, lat2, lon2)));
  }

  private static int toIlon(double lon) {
    return (int) (180000000 + lon * 1000000);
  }

  private static int toIlat(double lat) {
    return (int) (90000000 + lat * 1000000);
  }

  // -------------------------------------------------------------------------
  // SortedHeap — the Dijkstra open set
  // -------------------------------------------------------------------------

  /**
   * Push {@code n} pseudo-random keys through a {@link SortedHeap}, drain it, and
   * fold the pop order into a checksum. The checksum only matches if the heap
   * returns keys in the same order under both runtimes.
   *
   * @return a checksum over the pop order, mixed with the number of elements drained
   */
  @JSExport
  public static int heapBenchmark(int n) {
    SortedHeap<Integer> heap = new SortedHeap<>();

    // A plain LCG rather than java.util.Random: int overflow wraps identically
    // everywhere, and it keeps the kernel free of classlib surface area.
    int seed = 12345;
    for (int i = 0; i < n; i++) {
      seed = seed * 1103515245 + 12345;
      int key = seed >>> 8; // non-negative, as routing costs always are
      heap.add(key, Integer.valueOf(i));
    }

    int checksum = 0;
    int drained = 0;
    Integer value;
    while ((value = heap.popLowestKeyValue()) != null) {
      checksum = checksum * 31 + value.intValue();
      drained++;
    }
    return checksum ^ drained;
  }

  // -------------------------------------------------------------------------
  // Crc32
  // -------------------------------------------------------------------------

  /**
   * Run {@code n} CRC passes over a 4 KB buffer, feeding each result back into the
   * buffer so the iterations cannot be optimised away or reordered.
   */
  @JSExport
  public static int crcBenchmark(int n) {
    byte[] ab = new byte[4096];
    for (int i = 0; i < ab.length; i++) {
      ab[i] = (byte) (i * 31 + 7);
    }

    int crc = 0;
    for (int i = 0; i < n; i++) {
      ab[i & 4095] = (byte) crc;
      crc = Crc32.crc(ab, 0, ab.length);
    }
    return crc;
  }
}
