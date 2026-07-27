package btools.util;

import java.io.File;

/**
 * Build-time substitution for upstream {@code btools.util.StackSampler}, which cannot be
 * translated to WasmGC.
 * <p>
 * Upstream's version is a debug aid: a {@link Thread} that periodically calls
 * {@code getAllStackTraces()} and writes stacks to a log. Three of its dependencies do not
 * exist in TeaVM's class library — {@code Thread.getAllStackTraces()},
 * {@code Thread.getState()} and {@code java.util.Locale$Builder}.
 * <p>
 * It cannot simply be dropped: {@code RoutingEngine} imports it, holds a field of its type,
 * and constructs it at {@code RoutingEngine.java:128}, so TeaVM's reachability analysis pulls
 * it in regardless of whether it ever executes. (The plan's instruction to "exclude
 * StackSampler" is therefore only achievable by substitution, not by dead-code elimination.)
 * <p>
 * Substituting it is safe because it is unreachable in practice: construction sits behind
 * {@code infoLogEnabled} — which is {@code outfileBase != null}, and we always pass
 * {@code null}, exactly as the Android app and brouter-server do — and additionally behind a
 * {@code stacks.txt} file existing. Everything upstream's version would log is debug output
 * that a browser build has no use for.
 * <p>
 * The API surface is only what {@code RoutingEngine} touches: the constructor, {@code start()}
 * (inherited), and {@code close()}.
 *
 * @see <a href="../../../../../docs/spike-1-results.md">docs — build-time substitutions</a>
 */
public class StackSampler extends Thread {

  /**
   * @param logfile  ignored; upstream appends stack dumps here
   * @param interval ignored; upstream's sampling period in milliseconds
   */
  public StackSampler(File logfile, int interval) {
    // Intentionally empty.
  }

  /** No-op. Overridden so no green thread is spawned merely to do nothing. */
  @Override
  public synchronized void start() {
    // Intentionally empty.
  }

  @Override
  public void run() {
    // Intentionally empty.
  }

  /** No-op counterpart to upstream's flush-and-close. */
  public void close() {
    // Intentionally empty.
  }
}
