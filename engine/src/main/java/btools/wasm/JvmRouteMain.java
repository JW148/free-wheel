package btools.wasm;

import java.io.File;
import java.io.IOException;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Generates the JVM reference routes that the Wasm build is checked against.
 * <p>
 * Calls {@link Router#routeIn} — the very method the browser calls — against the real
 * filesystem, then records each route's GPX byte length and CRC-32. The browser replays the
 * same cases out of OPFS and must produce identical numbers.
 * <p>
 * Writes:
 * <ul>
 *   <li>{@code web/public/engine/jvm-routes.json} — the corpus plus expected length/CRC</li>
 *   <li>{@code build/reference-gpx/<id>.gpx} — the full GPX, for eyeballing a mismatch</li>
 * </ul>
 * Java 11, like the rest of the build.
 */
public final class JvmRouteMain {

  private JvmRouteMain() {
  }

  private static final class RouteCase {
    final String id;
    final String profile;
    final String lonLats;
    final String note;

    RouteCase(String id, String profile, String lonLats, String note) {
      this.id = id;
      this.profile = profile;
      this.lonLats = lonLats;
      this.note = note;
    }
  }

  public static void main(String[] args) throws IOException {
    String profileDir = args.length > 0 ? args[0] : "../web/public/profiles2";
    String segmentDir = args.length > 1 ? args[1] : "../data/segments4";
    File out = new File(args.length > 2 ? args[2] : "../web/public/engine/jvm-routes.json");
    File gpxDir = new File("build/reference-gpx");

    List<RouteCase> cases = new ArrayList<>();
    // All inside W5_N50.rd5, so no cross-tile seam is involved yet.
    cases.add(new RouteCase("urban-short", "trekking",
      "-0.1278,51.5074|-0.1425,51.5010",
      "~1.5 km across central London; smallest useful search"));
    cases.add(new RouteCase("urban-medium", "trekking",
      "-0.1278,51.5074|-0.0754,51.5155",
      "~4 km London, City-bound; several turn decisions"));
    cases.add(new RouteCase("fastbike-medium", "fastbike",
      "-0.1278,51.5074|-0.0754,51.5155",
      "same waypoints, different cost function — proves the profile is really read"));
    cases.add(new RouteCase("shortest-medium", "shortest",
      "-0.1278,51.5074|-0.0754,51.5155",
      "same waypoints again, minimal profile"));
    cases.add(new RouteCase("gravel-medium", "gravel",
      "-0.1278,51.5074|-0.0754,51.5155",
      "same waypoints, gravel costing"));
    cases.add(new RouteCase("london-brighton", "trekking",
      "-0.1278,51.5074|-0.1372,50.8225",
      "~76 km; the long case, and the one that will show the quadratic wall"));

    // Cross-tile. Everything above sits inside W5_N50, so the seam-handling path in
    // OsmFile/PhysicalFile has never actually executed. The Greenwich meridian is the
    // W5_N50 | E0_N50 boundary, which makes London ideal for exercising it.
    cases.add(new RouteCase("cross-tile-short", "trekking",
      "-0.0875,51.5079|0.2196,51.4465",
      "~25 km London Bridge to Dartford; crosses the meridian, so W5_N50 -> E0_N50"));
    cases.add(new RouteCase("cross-tile-long", "trekking",
      "-0.1278,51.5074|1.0789,51.2798",
      "~90 km London to Canterbury; well into the neighbouring tile"));
    cases.add(new RouteCase("east-only", "trekking",
      "0.2196,51.4465|1.0789,51.2798",
      "~70 km entirely inside E0_N50; proves the second tile stands alone"));

    if (!gpxDir.exists() && !gpxDir.mkdirs()) {
      throw new IOException("could not create " + gpxDir);
    }

    StringBuilder json = new StringBuilder();
    json.append("{\n");
    json.append("  \"generatedBy\": \"JVM ").append(System.getProperty("java.version")).append("\",\n");
    json.append("  \"profileDir\": ").append(quote(profileDir)).append(",\n");
    json.append("  \"segmentDir\": ").append(quote(segmentDir)).append(",\n");
    json.append("  \"routes\": [\n");

    int failures = 0;
    for (int i = 0; i < cases.size(); i++) {
      RouteCase c = cases.get(i);

      long t0 = System.nanoTime();
      String gpx = Router.routeIn(profileDir, segmentDir, c.profile, c.lonLats);
      double ms = (System.nanoTime() - t0) / 1_000_000.0;

      boolean ok = !gpx.startsWith("error:");
      if (!ok) {
        failures++;
        System.err.println("FAILED " + c.id + ": " + gpx);
      } else {
        PrintWriter w = new PrintWriter(new File(gpxDir, c.id + ".gpx"), StandardCharsets.UTF_8);
        try {
          w.print(gpx);
        } finally {
          w.close();
        }
      }

      System.out.printf("%-18s %-10s %8.1f ms  %s%n", c.id, c.profile, ms,
        ok ? Router.utf8Length(gpx) + " bytes, crc " + Router.crc32Utf8(gpx) : gpx);

      json.append("    {\"id\": ").append(quote(c.id))
        .append(", \"profile\": ").append(quote(c.profile))
        .append(", \"lonLats\": ").append(quote(c.lonLats))
        .append(", \"note\": ").append(quote(c.note))
        .append(", \"ok\": ").append(ok)
        .append(", \"gpxLength\": ").append(ok ? Router.utf8Length(gpx) : -1)
        .append(", \"gpxCrc32\": ").append(ok ? Router.crc32Utf8(gpx) : 0)
        .append(", \"jvmMs\": ").append(Math.round(ms * 10) / 10.0)
        .append(", \"tiles\": ").append(strings(tilesFor(c.lonLats)))
        .append("}").append(i < cases.size() - 1 ? "," : "").append("\n");
    }

    json.append("  ]\n}");

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
    System.err.println("reference GPX in " + gpxDir.getCanonicalPath());
    if (failures > 0) {
      throw new IOException(failures + " of " + cases.size() + " routes failed");
    }
  }

  /**
   * The 5x5 degree tiles a route's waypoints fall in, named by south-west corner.
   *
   * Only the endpoints are considered, so a route detouring through a third tile would not
   * be listed — good enough for telling the UI which tiles to import, and deliberately not
   * a substitute for the router's own tile loading.
   */
  private static List<String> tilesFor(String lonLats) {
    List<String> tiles = new ArrayList<>();
    for (String point : lonLats.split(";|\\|")) {
      String[] parts = point.split(",");
      if (parts.length < 2) {
        continue;
      }
      int lon = (int) Math.floor(Double.parseDouble(parts[0]) / 5) * 5;
      int lat = (int) Math.floor(Double.parseDouble(parts[1]) / 5) * 5;
      String name = (lon < 0 ? "W" + (-lon) : "E" + lon) + "_" + (lat < 0 ? "S" + (-lat) : "N" + lat);
      if (!tiles.contains(name)) {
        tiles.add(name);
      }
    }
    return tiles;
  }

  private static String strings(List<String> values) {
    StringBuilder sb = new StringBuilder("[");
    for (int i = 0; i < values.size(); i++) {
      if (i > 0) {
        sb.append(", ");
      }
      sb.append(quote(values.get(i)));
    }
    return sb.append("]").toString();
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
