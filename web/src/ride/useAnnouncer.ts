import { useCallback, useEffect, useRef } from 'react'
import { cueFor, type CueInput } from './cues'

/**
 * Speaks the cues that `cues.ts` decides on.
 *
 * Everything interesting is in `cues.ts`; this is the part that talks to the browser, and it
 * exists as its own hook only because `speechSynthesis` has three sharp edges:
 *
 * **1. The first utterance needs a user gesture.** iOS refuses `speak()` until the page has
 * spoken once from inside a tap, and it refuses *silently* — no error, no event, the utterance
 * simply never starts. So {@link prime} is called from the Start button, which is a tap, and
 * everything after that works unprompted.
 *
 * **2. Utterances queue.** By default a second `speak()` waits behind the first. On a bike that
 * means hearing about a climb you have already started while the next cue stacks up behind it.
 * Each cue cancels whatever is speaking: cues are only ever issued when they are worth
 * interrupting for, so the newest is always the one that matters.
 *
 * **3. The voice list loads asynchronously**, and picking one before it does gets you silence
 * on some platforms. Nothing here picks a voice — the default for the document language is
 * both correct and immune to this.
 *
 * The whole thing is a no-op where `speechSynthesis` is missing, and the caller can see that
 * through `supported` so the mute button can be hidden rather than lying.
 */
export function useAnnouncer(enabled: boolean, input: CueInput | null) {
  const said = useRef(new Set<string>())
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window

  const say = useCallback(
    (text: string) => {
      if (!supported) return
      try {
        window.speechSynthesis.cancel()
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
    said.current = new Set()
    say('Ride started.')
  }, [say])

  // A ride that ends and starts again should hear its cues again; the route is the same but
  // the ride is not.
  useEffect(() => {
    if (!enabled) {
      said.current = new Set()
      if (supported) window.speechSynthesis.cancel()
    }
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
