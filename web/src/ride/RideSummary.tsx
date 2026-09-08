import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Drawer } from 'vaul'
import { defaultRouteName, deleteEntry, putEntry, rideEntry, type SavedRide } from './library'
import { traceToGpx, worthKeeping, type RideRecord, type RideSummary } from './recording'
import RideStats from './RideStats'
import { shareGpx } from './share'

/**
 * What the ride was, the moment it ends.
 *
 * ## It saves itself, and that is the change
 *
 * This used to ask. There was a name field and a Save button, and dismissing the sheet threw
 * the ride away — which is defensible for a decision that is only interesting for thirty
 * seconds, and wrong for the only copy of something that took two hours to make. Two things
 * came out of riding it:
 *
 * - **The stats were unreachable afterwards.** Dismiss the sheet and the ride's figures were
 *   gone even if it *had* been saved, because nothing in the library opened them.
 * - **The name field summoned iOS's shake-to-undo.** A text input with typing history in it,
 *   plus a bike on cobbles, is an "Undo Typing" alert every few seconds. WebKit offers no way
 *   to refuse the alert, so the only fix is to have no text field on the riding screen at all.
 *
 * So the ride is written to the library as soon as the sheet appears, under the generated
 * date-and-distance name, and this screen becomes a *report* rather than a decision: here is
 * what happened, it is kept, and here are the two things you might want to do about it. Naming
 * happens in the library, where the rider has stopped and a keyboard costs nothing.
 *
 * A ride under 200 m is still not kept at all (`worthKeeping`): that is a mis-tap on Start.
 */
export default function RideSummarySheet({
  summary,
  record,
  onDismiss,
}: {
  summary: RideSummary
  record: RideRecord
  onDismiss: () => void
}) {
  const keepable = worthKeeping(record)
  const [state, setState] = useState<'saving' | 'saved' | 'failed' | 'discarded'>('saving')
  const [problem, setProblem] = useState<string | null>(null)
  const [entry, setEntry] = useState<SavedRide | null>(null)

  // Built once, so a retry writes the same record under the same id rather than a second copy.
  const candidate = useMemo(() => {
    const name = defaultRouteName(summary.startedAt, summary.distanceM)
    return rideEntry({ name, summary, gpx: traceToGpx(record, name), trace: record.trace })
  }, [summary, record])

  const save = useCallback(async () => {
    setState('saving')
    setProblem(null)
    try {
      await putEntry(candidate)
      setEntry(candidate)
      setState('saved')
    } catch (e) {
      // The ride is still on screen and still exportable. Say what happened rather than
      // pretending it saved.
      setProblem(e instanceof Error ? e.message : String(e))
      setState('failed')
    }
  }, [candidate])

  // Once, on arrival. A ref rather than a dependency-free effect because StrictMode runs
  // effects twice on the same instance, and the second run would write a duplicate.
  const attempted = useRef(false)
  useEffect(() => {
    if (!keepable || attempted.current) return
    attempted.current = true
    void save()
  }, [keepable, save])

  const discard = async () => {
    try {
      if (entry) await deleteEntry('ride', entry.id)
      setState('discarded')
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e))
    }
  }

  const exportGpx = () =>
    void shareGpx(
      candidate.gpx,
      `free-wheel-ride-${new Date(summary.startedAt).toISOString().slice(0, 10)}`,
    )

  return (
    <Drawer.Root open onOpenChange={(open) => !open && onDismiss()}>
      <Drawer.Portal>
        <Drawer.Overlay className="drawer-overlay" />
        <Drawer.Content className="drawer" aria-describedby={undefined}>
          <Drawer.Handle className="drawer-handle" />
          <div className="drawer-body">
            <div className="drawer-head">
              <Drawer.Title className="drawer-title">
                {keepable ? 'Ride finished' : 'That was a short one'}
              </Drawer.Title>
              <button type="button" className="primary" onClick={onDismiss}>
                Done
              </button>
            </div>

            <RideStats summary={summary} />

            {!keepable ? (
              <p className="warn">
                Under 200 m, so there is nothing worth keeping. Nothing was recorded.
              </p>
            ) : state === 'discarded' ? (
              <p className="warn">Thrown away. Nothing was kept.</p>
            ) : (
              <>
                <p className="warn">
                  {state === 'saved'
                    ? `Saved as “${candidate.name}”. It is in the library under Saved, where you can rename it, see these figures again, or ride it back.`
                    : state === 'saving'
                      ? 'Saving to the library…'
                      : 'It is not saved. The ride is still here — try again, or export it.'}
                </p>
                <div className="sheet-actions">
                  {state === 'failed' && (
                    <button type="button" className="primary" onClick={() => void save()}>
                      Try again
                    </button>
                  )}
                  <button type="button" onClick={exportGpx}>
                    Export GPX
                  </button>
                  {state === 'saved' && (
                    <button type="button" onClick={() => void discard()}>
                      Throw it away
                    </button>
                  )}
                </div>
              </>
            )}

            {problem && (
              <p className="warn" role="alert">
                Could not save it: {problem}
              </p>
            )}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}
