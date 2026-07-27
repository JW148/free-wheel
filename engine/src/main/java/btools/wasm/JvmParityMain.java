package btools.wasm;

import java.io.File;
import java.io.IOException;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Produces the JVM reference values and timings that the Wasm and JS builds are
 * checked against.
 * <p>
 * The output JSON carries the <em>case definitions</em> as well as the expected
 * results, so the browser side reads the cases from this file and executes them
 * rather than restating them in TypeScript. There is therefore no second copy of
 * the test corpus to drift out of sync.
 * <p>
 * JVM-only: never reachable from {@link SpikeMain#main}, so TeaVM prunes it.
 * Written to Java 11 like the rest of the build — no records, no switch
 * expressions.
 */
public final class JvmParityMain {

  private JvmParityMain() {
  }

  /** A deterministic kernel invocation with its expected result, as a string. */
  private static final class Case {
    final String id;
    final String kind;
    final double[] args;
    final String expected;
    final String note;

    Case(String id, String kind, double[] args, String expected, String note) {
      this.id = id;
      this.kind = kind;
      this.args = args;
      this.expected = expected;
      this.note = note;
    }
  }

  /** A kernel invocation run repeatedly for timing. */
  private static final class Benchmark {
    final String id;
    final String kind;
    final double[] args;
    final int iterations;
    final double bestMs;

    Benchmark(String id, String kind, double[] args, int iterations, double bestMs) {
      this.id = id;
      this.kind = kind;
      this.args = args;
      this.iterations = iterations;
      this.bestMs = bestMs;
    }
  }

  public static void main(String[] args) throws IOException {
    File out = new File(args.length > 0 ? args[0] : "../web/public/engine/jvm-reference.json");

    List<Case> cases = new ArrayList<>();

    // CheapRuler — short urban hop, a routing-scale leg, and a long haul that
    // crosses several entries of the latitude scale cache.
    addDistance(cases, "distance/hyde-park-corner", 51.502, -0.152, 51.507, -0.144,
      "~800 m; sub-kilometre precision");
    addDistance(cases, "distance/london-brighton", 51.5074, -0.1278, 50.8225, -0.1372,
      "~76 km; a realistic single-day route length");
    addDistance(cases, "distance/london-paris", 51.5074, -0.1278, 48.8566, 2.3522,
      "~340 km; spans multiple scale-cache buckets");

    // SortedHeap — the Dijkstra open set. 200k is the interesting one: it forces
    // repeated sortUp() merges rather than staying in the first two bins.
    addInt(cases, "heap/1000", "heapBenchmark", 1000,
      "small heap, stays in the low bins");
    addInt(cases, "heap/200000", "heapBenchmark", 200000,
      "forces repeated bin merges; the shape of a real route search");

    // Crc32 — tight byte-array loop, the codec path's shape.
    addInt(cases, "crc/1000", "crcBenchmark", 1000,
      "1000 passes over 4 KB");

    List<Benchmark> benchmarks = new ArrayList<>();
    benchmarks.add(time("bench/heap/200000", "heapBenchmark", 200000, 5));
    benchmarks.add(time("bench/crc/5000", "crcBenchmark", 5000, 5));

    String json = render(cases, benchmarks);

    System.out.println(json);

    File parent = out.getParentFile();
    if (parent != null && !parent.exists() && !parent.mkdirs()) {
      throw new IOException("could not create " + parent);
    }
    PrintWriter w = new PrintWriter(out, StandardCharsets.UTF_8);
    try {
      w.println(json);
    } finally {
      w.close();
    }
    System.err.println("wrote " + out.getCanonicalPath());
  }

  private static void addDistance(List<Case> cases, String id,
                                  double lat1, double lon1, double lat2, double lon2, String note) {
    double metres = SpikeMain.distance(lat1, lon1, lat2, lon2);
    String bits = SpikeMain.distanceBits(lat1, lon1, lat2, lon2);
    cases.add(new Case(id, "distanceBits", new double[]{lat1, lon1, lat2, lon2}, bits,
      note + " (JVM: " + metres + " m)"));
  }

  private static void addInt(List<Case> cases, String id, String kind, int n, String note) {
    cases.add(new Case(id, kind, new double[]{n}, Integer.toString(run(kind, n)), note));
  }

  /** Best-of-{@code runs} wall time, after one discarded warmup run. */
  private static Benchmark time(String id, String kind, int n, int runs) {
    run(kind, n); // warmup: let the JIT settle before we quote a number

    double bestMs = Double.MAX_VALUE;
    for (int i = 0; i < runs; i++) {
      long t0 = System.nanoTime();
      run(kind, n);
      double ms = (System.nanoTime() - t0) / 1_000_000.0;
      if (ms < bestMs) {
        bestMs = ms;
      }
    }
    return new Benchmark(id, kind, new double[]{n}, runs, bestMs);
  }

  private static int run(String kind, int n) {
    if ("heapBenchmark".equals(kind)) {
      return SpikeMain.heapBenchmark(n);
    }
    if ("crcBenchmark".equals(kind)) {
      return SpikeMain.crcBenchmark(n);
    }
    throw new IllegalArgumentException("unknown kernel: " + kind);
  }

  private static String render(List<Case> cases, List<Benchmark> benchmarks) {
    StringBuilder sb = new StringBuilder();
    sb.append("{\n");
    sb.append("  \"generatedBy\": \"JVM ").append(System.getProperty("java.version"))
      .append(" (").append(System.getProperty("java.vm.name")).append(")\",\n");
    sb.append("  \"cases\": [\n");
    for (int i = 0; i < cases.size(); i++) {
      Case c = cases.get(i);
      sb.append("    {\"id\": ").append(quote(c.id))
        .append(", \"kind\": ").append(quote(c.kind))
        .append(", \"args\": ").append(numbers(c.args))
        .append(", \"expected\": ").append(quote(c.expected))
        .append(", \"note\": ").append(quote(c.note))
        .append("}").append(i < cases.size() - 1 ? "," : "").append("\n");
    }
    sb.append("  ],\n");
    sb.append("  \"benchmarks\": [\n");
    for (int i = 0; i < benchmarks.size(); i++) {
      Benchmark b = benchmarks.get(i);
      sb.append("    {\"id\": ").append(quote(b.id))
        .append(", \"kind\": ").append(quote(b.kind))
        .append(", \"args\": ").append(numbers(b.args))
        .append(", \"iterations\": ").append(b.iterations)
        .append(", \"jvmBestMs\": ").append(round(b.bestMs))
        .append("}").append(i < benchmarks.size() - 1 ? "," : "").append("\n");
    }
    sb.append("  ]\n");
    sb.append("}");
    return sb.toString();
  }

  private static String numbers(double[] values) {
    StringBuilder sb = new StringBuilder("[");
    for (int i = 0; i < values.length; i++) {
      if (i > 0) {
        sb.append(", ");
      }
      double v = values[i];
      sb.append(v == Math.rint(v) && Math.abs(v) < 1e15 ? Long.toString((long) v) : Double.toString(v));
    }
    return sb.append("]").toString();
  }

  private static double round(double ms) {
    return Math.round(ms * 1000.0) / 1000.0;
  }

  private static String quote(String s) {
    StringBuilder sb = new StringBuilder("\"");
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      if (c == '"') {
        sb.append("\\\"");
      } else if (c == '\\') {
        sb.append("\\\\");
      } else if (c == '\n') {
        sb.append("\\n");
      } else {
        sb.append(c);
      }
    }
    return sb.append("\"").toString();
  }
}
