import { useCallback, useEffect, useRef } from 'react'
import { cueFor, type CueInput } from './cues'

/**
 * Speaks the cues that `cues.ts` decides on.
 *
 * Everything interesting is in `cues.ts`; this is the part that talks to the browser, and it
 * exists as its own hook only because `speechSynthesis` has three sharp edges, all of which
 * fail *silently*:
 *
 * **1. The first utterance needs a user gesture.** iOS refuses `speak()` until the page has
 * spoken once from inside a tap — no error, no event, the utterance simply never starts. Both
 * ways into speech are therefore taps: {@link prime} from the Start button, and {@link say}
 * from the mute toggle when it is switched back on.
 *
 * **2. Utterances queue.** By default a second `speak()` waits behind the first. On a bike that
 * means hearing about a climb you have already started while the next cue stacks up behind it.
 * So each cue cancels whatever is speaking — *except* immediately after priming, see
 * {@link PRIME_GRACE_MS}.
 *
 * **3. The voice list loads asynchronously**, and picking one before it does gets you silence
 * on some platforms. Nothing here picks a voice — the default for the document language is
 * both correct and immune to this.
 *
 * The whole thing is a no-op where `speechSynthesis` is missing, and the caller can see that
 * through `supported` so the mute button can be hidden rather than lying.
 */

/**
 * How long the priming utterance is protected from being cancelled.
 *
 * Two reasons, and the second is the serious one. "Ride started" is about a second long and a
 * cue arriving on the first fix would clip it — but worse, that cue would be cancelling the
 * gesture-initiated utterance *before it has begun speaking*, and it is the act of that
 * utterance starting that unlocks speech for the rest of the session on iOS. Losing it costs
 * every cue for the whole ride. Two seconds of queueing instead of interrupting is cheap
 * insurance, and the first fix is the least likely one to be carrying something urgent.
 */
const PRIME_GRACE_MS = 2000

export function useAnnouncer(
  enabled: boolean,
  input: CueInput | null,
  /**
   * Identifies the ride. When it changes, everything already said is forgotten.
   *
   * Deliberately *not* `enabled`. Muting is not the end of a ride, and resetting on it means
   * un-muting replays every cue whose condition is still true — a climb you are halfway up
   * announced again as though it were ahead of you.
   */
  session: unknown,
) {
  const said = useRef(new Set<string>())
  const primedAt = useRef(0)
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window

  const say = useCallback(
    (text: string) => {
      if (!supported) return
      try {
        if (Date.now() - primedAt.current > PRIME_GRACE_MS) window.speechSynthesis.cancel()
        const utterance = new SpeechSynthesisUtterance(text)
        utterance.lang = document.documentElement.lang || navigator.language || 'en-GB'
        // A shade under normal. Road noise and a phone speaker at arm's length take the top
        // off consonants, and the default rate loses the difference between "sixteen" and
        // "sixty" — which for a gradient is the whole message.
        utterance.rate = 0.95
        window.speechSynthesis.speak(utterance)
      } catch {
        // A synthesiser that refuses is not a reason to stop the ride. The screen still says
        // everything this would have.
      }
    },
    [supported],
  )

  /**
   * Must be called from a tap. Unlocks speech for the rest of the session on iOS.
   *
   * Deliberately does **not** check `enabled`. It is called from the handler that starts the
   * ride, and at that moment `riding` is still false in the render this closure came from — so
   * gating on `enabled` here silently swallowed the one utterance that has to get through, and
   * with it every cue for the rest of the ride. The caller checks the mute setting instead,
   * which it can see correctly.
   */
  const prime = useCallback(() => {
    primedAt.current = Date.now()
    say('Ride started.')
  }, [say])

  // A ride that ends and starts again should hear its cues again; the route is the same but
  // the ride is not. Keyed on the ride rather than on the mute setting — see `session`.
  useEffect(() => {
    said.current = new Set()
  }, [session])

  // Muting stops what is being said now. It does not forget what has been said.
  useEffect(() => {
    if (!enabled && supported) window.speechSynthesis.cancel()
  }, [enabled, supported])

  useEffect(() => {
    if (!enabled || !input) return
    const cue = cueFor(input, said.current)
    if (!cue) return
    said.current.add(cue.key)
    say(cue.text)
  }, [enabled, input, say])

  return { supported, prime, say }
}
