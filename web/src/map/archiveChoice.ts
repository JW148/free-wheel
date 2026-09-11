/**
 * What the map should be drawing, decided without touching a map.
 *
 * Every archive a phone has downloaded is drawn at once, so this is no longer a choice between
 * archives — it is a *diff* between what is installed and what is currently mounted, plus the
 * one genuine choice left: where the camera opens.
 *
 * Pure, and separate from `useMapLibre`, because this is the part that can be wrong in a way
 * nothing on screen would report. A mount plan that forgets to remove a deleted region leaves
 * a source pointed at a file that is no longer there, and MapLibre answers a missing tile with
 * silence.
 */

/**
 * Which archive the camera opens on: a preference, then the next preference, then whatever is
 * actually there.
 *
 * A preference naming an archive that is no longer installed is skipped rather than honoured as
 * a miss — a rider whose remembered region was deleted should get one they still have, not
 * nothing.
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
 * What a rider ended up looking at after the map was brought in line with storage.
 *
 * - `ready` — every installed archive is drawn.
 * - `nothing-installed` — the map is down because there is nothing to show. An empty phone;
 *   the ride screen says so and offers the way to fix it.
 * - `unavailable` — the map is down because storage could not be read, or nothing would mount.
 *   A different sentence from "you have no map yet", with a different remedy.
 * - `partial` — some archives are drawn and at least one would not open. The map still works
 *   where it has data, so tearing it down would turn one bad archive into no map at all; the
 *   error stands and the rider keeps what works.
 */
export type MapOutcome = 'ready' | 'nothing-installed' | 'unavailable' | 'partial'

/** How to bring the map in line with storage. */
export type MountPlan =
  | {
      action: 'mount'
      /** Every archive that should end up drawn. */
      mount: string[]
      /** Newly installed, to be spliced in. */
      add: string[]
      /** Drawn but no longer installed, to be taken off. */
      remove: string[]
      /** Where the camera opens, when the map is being built from nothing. */
      focus: string
    }
  | { action: 'discard'; outcome: 'nothing-installed' | 'unavailable' }

/**
 * The diff between what is installed and what is on the map.
 *
 * `remove` is not an afterthought. An archive whose file has been deleted leaves a source
 * behind that MapLibre goes on requesting tiles from, and a missing tile is reported as
 * nothing at all — so a deleted region would keep its layers, draw nothing into them, and look
 * exactly like a region that had failed to download.
 */
export function mountPlan(
  installed: { name: string }[],
  mounted: string[],
  preferences: (string | null | undefined)[],
): MountPlan {
  const focus = archiveToOpen(installed, preferences)
  if (focus === null) return { action: 'discard', outcome: 'nothing-installed' }
  const mount = installed.map((archive) => archive.name)
  return {
    action: 'mount',
    mount,
    add: mount.filter((name) => !mounted.includes(name)),
    remove: mounted.filter((name) => !mount.includes(name)),
    focus,
  }
}
