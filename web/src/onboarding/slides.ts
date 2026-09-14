import type { GlyphName } from './glyphs'
import type { PositionId, TyreId } from '../ride/rider'
import type { ProfileId } from '../ride/profiles'

/**
 * What the first run says, and what one of its answers changes.
 *
 * Pure, and separate from the screen that draws it, because the one card that *does* something
 * — the bike question — has consequences three modules away and those are worth testing
 * without a DOM.
 */

export interface Slide {
  glyph: GlyphName
  title: string
  body: string
  /** Shows the bike chips. Exactly one card does. */
  bikes?: true
  /** Shows the location reassurance, and turns the button into the permission prompt. */
  location?: true
}

export const SLIDES: Slide[] = [
  {
    glyph: 'bike',
    title: 'Routes, with the network off',
    body:
      'Free Wheel plans and follows cycle routes entirely on your phone. No account, no ' +
      'server — nothing leaves the device.',
  },
  {
    glyph: 'britain',
    title: 'Download where you ride',
    body:
      'Pick an area of Britain once. The map and the road data live on the phone, so it ' +
      'works in the hills and in the tunnel.',
  },
  {
    glyph: 'taps',
    title: 'Two taps, three routes',
    body:
      'Tap your start, tap your finish. You get a relaxed, a fast and an off-road option to ' +
      'pick from — no settings first.',
  },
  {
    glyph: 'bikes',
    title: 'What are you riding?',
    body: 'This sets which route we suggest first. You can change it any time.',
    bikes: true,
  },
  {
    glyph: 'climb',
    title: 'Follow it on the road',
    body:
      'Speed, the next climb, how far to go and when you arrive — and a voice that tells ' +
      'you about the hill before you see it.',
  },
  {
    glyph: 'locate',
    title: 'Where are you?',
    body:
      'Allow location so the map can find you, follow you on the ride and route again if ' +
      'you wander off the line.',
    location: true,
  },
]

/**
 * What a bike answers.
 *
 * One chip sets three things: which route style is offered first, and the two inputs to the
 * power model that a rider will otherwise never touch. That is the whole argument for asking
 * the question here — `position` and `tyres` are the largest error terms in the flat-ground
 * estimate, they are buried in a settings screen, and "what do you ride" is a question
 * somebody can actually answer.
 *
 * Every one of them is overridable later in *You and the bike*. This is a better starting
 * guess than the default, not a decision.
 */
export interface BikeChoice {
  id: string
  label: string
  profile: ProfileId
  position: PositionId
  tyres: TyreId
}

/**
 * A mountain bike maps to the **off-road** card rather than to the `mtb` profile.
 *
 * The three cards are a fixed vocabulary — Relaxed, Fast, Off-road — that a rider learns once
 * and then reads at a glance. Substituting a fourth name into the trio for one answer would
 * break that for the sake of a routing difference most riders will not notice on the road, and
 * `mtb` is one tap away under *More riding styles* for the ones who will.
 *
 * Where the answer does its real work is the two rows underneath: an MTB's tyres are nearly
 * four times the rolling resistance of a road tyre, and that moves every power figure the app
 * ever shows. The route it suggests is the smaller half of this question.
 */
export const BIKES: BikeChoice[] = [
  { id: 'hybrid', label: 'Hybrid / town', profile: 'trekking', position: 'upright', tyres: 'allroad' },
  { id: 'road', label: 'Road', profile: 'fastbike', position: 'hoods', tyres: 'road' },
  { id: 'gravel', label: 'Gravel', profile: 'gravel', position: 'hoods', tyres: 'gravel' },
  { id: 'mtb', label: 'Mountain', profile: 'gravel', position: 'upright', tyres: 'mtb' },
]

export const DEFAULT_BIKE = BIKES[0]

export const bikeById = (id: string): BikeChoice =>
  BIKES.find((b) => b.id === id) ?? DEFAULT_BIKE

const STORAGE_KEY = 'free-wheel.onboarded.v1'

/**
 * Whether the walkthrough has been seen.
 *
 * Its own key, deliberately **not** "is anything installed". Those are different questions with
 * different remedies: a rider who deletes every region to free space needs the maps screen,
 * not a six-card introduction to an app they have been using for a month. Skipping counts as
 * seeing it — a rider who skipped has answered the question.
 */
export function hasOnboarded(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'yes'
  } catch {
    // Private browsing. Showing it again is annoying; refusing to start is worse.
    return false
  }
}

export function markOnboarded(): void {
  try {
    localStorage.setItem(STORAGE_KEY, 'yes')
  } catch {
    // As above.
  }
}
