/**
 * Which installed basemap archive to open.
 *
 * Two callers make this choice and, until the region picker existed, made it separately:
 * `useMapLibre`'s startup, which opens whatever you were last using, and `endRemote`, which
 * hands the map back after the picker has borrowed it. The rule is the same in both — a
 * preference, then the next preference, then whatever is actually there — so it is written
 * once.
 *
 * The case worth extracting it for is the one both share and neither used to state: **nothing
 * is installed**. That is a real answer, not a failure, and returning `null` forces it to be
 * an explicit branch at the call site instead of an `undefined` that flows on into `show()`.
 * Leaving a streamed archive on screen because the restore quietly did nothing is worse than
 * an empty map — it looks like a working map and silently is not.
 *
 * A preference naming an archive that is no longer installed is skipped rather than honoured
 * as a miss: a rider whose remembered archive was deleted should get the one they still have,
 * not nothing.
 */
export function archiveToOpen(
  installed: { name: string }[],
  preferences: (string | null | undefined)[],
): string | null {
  for (const wanted of preferences) {
    if (!wanted) continue
    const match = installed.find((archive) => archive.name === wanted)
    if (match) return match.name
  }
  return installed[0]?.name ?? null
}

/**
 * What the map is showing once a `showRemote` loan has been closed.
 *
 * The loan is always closed — `endRemote` never returns with a borrowed archive still on
 * screen — so this says what the rider ended up looking at, and it is the caller's job to
 * decide whether that is somewhere they can be left.
 *
 * - `restored` — a local archive is up, with the route and position layers on it.
 * - `nothing-installed` — the map is torn down because there is nothing to show. An empty
 *   phone that chose to carry on without a region; the ride screen says so.
 * - `unavailable` — the map is torn down because the handback *could not be done*: storage
 *   could not be read, or the archive would not mount. The engine's own error stands, and it
 *   is a different sentence from "you have no map yet" with a different remedy.
 */
export type Handback = 'restored' | 'nothing-installed' | 'unavailable'

/** What closing a loan has to do to the map, decided without touching one. */
export type HandbackPlan =
  | { action: 'mount'; name: string }
  | { action: 'discard'; outcome: 'nothing-installed' | 'unavailable' }

/**
 * How to give the map back, given what storage says is installed.
 *
 * `installed` is `null` when the engine could not be asked — which is not the same as an
 * empty list, and collapsing the two is how this went wrong: a handback that treats "cannot
 * read storage" as "nothing to do" returns successfully with the borrowed archive still on
 * screen. The rider is then looking at a streamed map of Britain wearing their map's clothes,
 * with no route source, no position source and a dead theme button, and nothing on screen
 * says so. Tearing it down and reporting the fault is worse-looking and far more honest.
 *
 * The two `discard` outcomes are kept apart for the same reason they are kept apart in the
 * copy: "you have no map yet" sends a rider to download one, and doing that with an engine
 * that cannot answer is a confident piece of wrong advice.
 */
export function handbackPlan(
  installed: { name: string }[] | null,
  preferences: (string | null | undefined)[],
): HandbackPlan {
  if (installed === null) return { action: 'discard', outcome: 'unavailable' }
  const name = archiveToOpen(installed, preferences)
  if (name === null) return { action: 'discard', outcome: 'nothing-installed' }
  return { action: 'mount', name }
}
