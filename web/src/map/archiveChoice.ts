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
