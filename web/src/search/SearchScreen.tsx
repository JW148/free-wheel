import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { loadManifest, type DataManifest } from '../data/manifest'
import { sharedEngine } from '../engine/engineClient'
import { downloadPlan } from '../data/regions'
import { withEndpoint, type PlanSlot } from '../ride/plan'
import type { Plan } from '../ride/useRoute'
import { downloads } from '../setup/downloadStore'
import { regionAt } from '../setup/regionShapes'
import { kindLabel, placeGlyph, type PlaceGlyph } from './kinds'
import type { SearchHit } from './placeIndex'
import { loadGazetteer, searchGazetteer, type GazetteerPlace } from './gazetteer'
import {
  iconFor,
  loadPlaces,
  loadRecents,
  placeEntry,
  savePlaces,
  saveRecents,
  withRecent,
  type PlaceIcon,
  type SavedPlace,
} from './places'
import { places, useIndexState } from './searchStore'

/**
 * Searching for somewhere to ride to, with the network off.
 *
 * ## Why this screen exists
 *
 * "As a user I wasn't sure how to start creating a route." The app's answer was a map and an
 * instruction to tap it, which works perfectly once you know where on the map you are going and
 * not at all before that. Every other map app on the phone opens with a search field, so the
 * absence of one reads as a missing feature rather than a design position — and the design
 * position was only ever about *reverse* geocoding, which this does not do.
 *
 * ## Both ends, on one screen
 *
 * Start and finish are two rows of the same field, and which one is being edited is the one that
 * is focused. That is the shape every rider already knows, and it is also the shape that makes
 * the empty state honest: with no start chosen there is only one row, because a finish with
 * nothing to leave from is not a journey.
 *
 * The three rows above the results are the three ways to answer that are not typing — where I
 * am, somewhere on the map, somewhere I have been — and they are the answer most of the time.
 *
 * ## What it does when it cannot help
 *
 * A search with no results is the dangerous state: it looks identical to a misspelling, to a
 * made-up place, and to a broken app. So an unmatched query is put to the shipped gazetteer of
 * British towns, and if it is a real place the screen says which region covers it and offers the
 * download. That is `explainRoutingFailure`'s move — name the thing to fetch — on the screen a
 * rider reaches first.
 */

export default function SearchScreen({
  plan,
  slot: initialSlot,
  near,
  onClose,
  onPicked,
  onChooseOnMap,
  onLocate,
  onOpenMaps,
}: {
  plan: Plan
  /** Which end the rider set out to choose. They can switch once they are here. */
  slot: PlanSlot
  /** Where distances are measured from: the rider, or failing that the middle of the map. */
  near: { lon: number; lat: number } | null
  onClose: () => void
  /**
   * Moves the map to frame the plan this is about to become. The screen has no map of its own.
   */
  onPicked: (coords: [number, number][]) => void
  onChooseOnMap: (slot: PlanSlot) => void
  onLocate: () => Promise<{ lon: number; lat: number; accuracy: number } | null>
  onOpenMaps: () => void
}) {
  const index = useIndexState()
  const [slot, setSlot] = useState<PlanSlot>(initialSlot)
  const [query, setQuery] = useState('')
  const [saved, setSaved] = useState<SavedPlace[]>(() => loadPlaces())
  const [recents, setRecents] = useState(() => loadRecents())
  const [locating, setLocating] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [naming, setNaming] = useState<{ lon: number; lat: number; name: string } | null>(null)
  const [editing, setEditing] = useState(false)
  const field = useRef<HTMLInputElement | null>(null)

  const start = plan.waypoints[0] ?? null
  const finish = plan.waypoints.length > 1 ? plan.waypoints[plan.waypoints.length - 1] : null

  // Focused on arrival, because the rider tapped a search field to get here and a field that
  // has to be tapped a second time is a field that did not open.
  useEffect(() => {
    field.current?.focus()
  }, [slot])

  /**
   * The results, recomputed as the rider types.
   *
   * No debounce, deliberately. The search is a native string scan over something already in
   * memory — a few milliseconds for 35,000 names — so a delay would only add latency to
   * something that is already faster than the keystroke that triggered it.
   */
  const hits = useMemo(
    () => (query.trim().length === 0 ? [] : places.search(query, near, 30)),
    // `index.ready` is not read in the body and is not spurious: `places.search` reads the
    // store's own loaded indexes, so this is the only signal that an archive has finished being
    // scanned and the answer has changed. Without it, a rider who opens search while the first
    // region is still indexing types a query, gets nothing, and never sees it fill in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, near, index.ready],
  )

  const [elsewhere, setElsewhere] = useState<GazetteerPlace[]>([])
  useEffect(() => {
    const text = query.trim()
    // Only when the phone has genuinely nothing, and only once there is enough typed to mean
    // something. Offering "did you mean a town 300 miles away" beside twelve local results is
    // noise; offering it instead of a blank screen is the whole point.
    if (text.length < 3 || hits.length > 0) {
      setElsewhere([])
      return
    }
    let live = true
    void loadGazetteer().then((loaded) => {
      if (live) setElsewhere(searchGazetteer(loaded, text, near))
    })
    return () => {
      live = false
    }
  }, [query, hits.length, near])

  const remember = useCallback((name: string, detail: string, lon: number, lat: number) => {
    setRecents((current) => {
      const next = withRecent(current, { name, detail, lon, lat, at: Date.now() })
      saveRecents(next)
      return next
    })
  }, [])

  /**
   * Committing a choice.
   *
   * Picking the start leaves the screen open on the finish, because a rider who has just said
   * where they are starting from is about to say where they are going — and closing the screen
   * to make them reopen it is the one thing that would make this slower than tapping the map.
   * Picking the finish closes, and the plan routes itself: two ends, three routes, which is the
   * flow the app has always had.
   */
  const pick = useCallback(
    (point: { lon: number; lat: number }, name: string, detail: string) => {
      onPicked(withEndpoint(plan.waypoints, slot, point).map((w) => [w.lon, w.lat]))
      plan.placeAt(slot, { ...point, label: name })
      remember(name, detail, point.lon, point.lat)
      setQuery('')
      if (slot === 'start' && plan.waypoints.length < 2) setSlot('finish')
      else onClose()
    },
    [plan, slot, remember, onClose, onPicked],
  )

  const locateMe = useCallback(async () => {
    setLocating(true)
    setProblem(null)
    try {
      const here = await onLocate()
      if (!here) {
        setProblem('No location fix yet. Check that location is allowed, or choose on the map.')
        return
      }
      // "My location" and not a place name: the app does not turn a position into a name, and
      // the one it would turn this into would be wrong by the time the rider read it.
      pick(here, 'My location', `accurate to ${Math.round(here.accuracy)} m`)
    } finally {
      setLocating(false)
    }
  }, [onLocate, pick])

  /**
   * The whole journey, in one tap: from where the rider is, to the place they keep.
   *
   * Offered only on the empty plan, and only in the start slot, because that is the only state
   * in which "Home" can mean one unambiguous thing. Anywhere else it would be guessing which
   * end of an existing plan the rider meant.
   *
   * `routeBetween` rather than two `placeAt` calls: the second would close over the waypoints
   * the first has not committed yet, and it is genuinely one decision rather than two.
   */
  const rideTo = useCallback(
    async (place: { name: string; lon: number; lat: number }, detail: string) => {
      setLocating(true)
      setProblem(null)
      try {
        const here = await onLocate()
        if (!here) {
          setProblem('No location fix yet, so there is no "here" to ride from. Pick a start.')
          return
        }
        onPicked([
          [here.lon, here.lat],
          [place.lon, place.lat],
        ])
        plan.routeBetween(
          { lon: here.lon, lat: here.lat, label: 'My location' },
          { lon: place.lon, lat: place.lat, label: place.name },
        )
        remember(place.name, detail, place.lon, place.lat)
        onClose()
      } finally {
        setLocating(false)
      }
    },
    [onLocate, onPicked, plan, remember, onClose],
  )

  const togglePlace = useCallback((name: string, lon: number, lat: number) => {
    setSaved((current) => {
      const existing = current.find(
        (place) => Math.abs(place.lon - lon) < 1e-4 && Math.abs(place.lat - lat) < 1e-4,
      )
      const next = existing
        ? current.filter((place) => place.id !== existing.id)
        : [...current, placeEntry({ name, lon, lat })]
      savePlaces(next)
      return next
    })
  }, [])

  const isSaved = (lon: number, lat: number) =>
    saved.some((place) => Math.abs(place.lon - lon) < 1e-4 && Math.abs(place.lat - lat) < 1e-4)

  const searching = query.trim().length > 0
  /**
   * Nothing planned yet, and the start is what is being chosen.
   *
   * The one state in which a saved place is unambiguously a *destination* — so it is the one
   * state that offers to ride there from wherever the rider is.
   */
  const fresh = slot === 'start' && plan.waypoints.length === 0

  return (
    <div className="screen search-screen">
      <header className="search-head">
        <button type="button" className="screen-back" onClick={onClose} aria-label="Back to the map">
          <ChevronLeftIcon />
        </button>

        <div className="search-fields">
          <SearchRow
            role="start"
            active={slot === 'start'}
            placeholder="Where are you starting?"
            value={slot === 'start' ? query : (start?.label ?? coords(start))}
            fieldRef={slot === 'start' ? field : undefined}
            onActivate={() => {
              setSlot('start')
              setQuery('')
            }}
            onChange={setQuery}
            onClear={() => setQuery('')}
          />
          {start && (
            <SearchRow
              role="finish"
              active={slot === 'finish' || slot === 'stop'}
              placeholder={slot === 'stop' ? 'Where do you want to stop?' : 'Where to?'}
              value={slot === 'finish' || slot === 'stop' ? query : (finish?.label ?? coords(finish))}
              fieldRef={slot === 'finish' || slot === 'stop' ? field : undefined}
              onActivate={() => {
                setSlot('finish')
                setQuery('')
              }}
              onChange={setQuery}
              onClear={() => setQuery('')}
            />
          )}
        </div>

        {start && finish && (
          <button
            type="button"
            className="search-swap"
            aria-label="Swap the start and the finish"
            onClick={() => plan.reverse()}
          >
            <SwapIcon />
          </button>
        )}
      </header>

      <div className="screen-body search-body">
        {problem && (
          <p className="warn" role="alert">
            {problem}
          </p>
        )}

        {!searching && (
          <>
            <ul className="place-list">
              <PlaceRow
                glyph="locate"
                title={locating ? 'Finding you…' : 'Start where I am'}
                detail="This phone's own fix, not a server"
                onPick={() => void locateMe()}
              />
              <PlaceRow
                glyph="map"
                title="Choose on the map"
                detail="Drop a pin anywhere, address or not"
                onPick={() => onChooseOnMap(slot)}
              />
            </ul>

            {recents.length > 0 && (
              <>
                <h2 className="section-label">Somewhere you've been</h2>
                <ul className="place-list">
                  {recents.map((recent) => (
                    <PlaceRow
                      key={`${recent.name}${recent.lon}`}
                      glyph="recent"
                      title={recent.name}
                      detail={recent.detail}
                      away={awayFrom(near, recent)}
                      saved={isSaved(recent.lon, recent.lat)}
                      onSave={() => togglePlace(recent.name, recent.lon, recent.lat)}
                      rideTo={fresh ? () => void rideTo(recent, recent.detail) : undefined}
                      onPick={() => pick(recent, recent.name, recent.detail)}
                    />
                  ))}
                </ul>
              </>
            )}

            <div className="section-head">
              <h2 className="section-label">Saved places</h2>
              {saved.length > 0 && (
                <button type="button" className="picker-plain" onClick={() => setEditing(!editing)}>
                  {editing ? 'Done' : 'Edit'}
                </button>
              )}
            </div>
            {saved.length === 0 ? (
              <p className="setup-footer">
                Nothing saved yet. Tap the star beside a result to keep it here — call one Home
                and one Work and they get their own icons.
              </p>
            ) : (
              <ul className="place-list">
                {saved.map((place) => (
                  <PlaceRow
                    key={place.id}
                    glyph={place.icon}
                    title={place.name}
                    detail={`${place.lat.toFixed(4)}, ${place.lon.toFixed(4)}`}
                    away={awayFrom(near, place)}
                    remove={
                      editing
                        ? () => {
                            const next = saved.filter((other) => other.id !== place.id)
                            setSaved(next)
                            savePlaces(next)
                          }
                        : undefined
                    }
                    rename={
                      editing
                        ? () => setNaming({ lon: place.lon, lat: place.lat, name: place.name })
                        : undefined
                    }
                    rideTo={
                      fresh && !editing ? () => void rideTo(place, 'Saved place') : undefined
                    }
                    onPick={() => pick(place, place.name, 'Saved place')}
                  />
                ))}
              </ul>
            )}

            {naming && (
              <RenamePlace
                initial={naming.name}
                onCancel={() => setNaming(null)}
                onSave={(name) => {
                  const next = saved.map((place) =>
                    place.lon === naming.lon && place.lat === naming.lat
                      ? { ...place, name: name.trim() || place.name, icon: iconFor(name) }
                      : place,
                  )
                  setSaved(next)
                  savePlaces(next)
                  setNaming(null)
                }}
              />
            )}
          </>
        )}

        {searching && hits.length > 0 && (
          <>
            <ul className="place-list">
              {hits.map((hit) => (
                <PlaceRow
                  key={`${hit.name}${hit.lon}${hit.kind}`}
                  glyph={placeGlyph(hit.category, hit.kind)}
                  title={hit.name}
                  detail={kindLabel(hit.category, hit.kind)}
                  away={hit.distanceM}
                  match={query}
                  saved={isSaved(hit.lon, hit.lat)}
                  onSave={() => togglePlace(hit.name, hit.lon, hit.lat)}
                  onPick={() => pick(hit, hit.name, kindLabel(hit.category, hit.kind))}
                />
              ))}
            </ul>
            <p className="setup-footer">
              <DownIcon />
              From {describeSources(hits)}, on this phone. Nothing is searched online.
            </p>
          </>
        )}

        {searching && hits.length === 0 && (
          <NothingHere
            query={query}
            index={index}
            elsewhere={elsewhere}
            onOpenMaps={onOpenMaps}
            onChooseOnMap={() => onChooseOnMap(slot)}
          />
        )}

        {!searching && index.building && (
          <p className="setup-footer">
            Reading the names out of {prettyArchive(index.building)} —{' '}
            {Math.round(index.progress * 100)}%. Search works on the regions that are done.
          </p>
        )}
      </div>
    </div>
  )
}

/** One row of the field stack: a badge, an input, and a way to empty it. */
function SearchRow({
  role,
  active,
  placeholder,
  value,
  fieldRef,
  onActivate,
  onChange,
  onClear,
}: {
  role: 'start' | 'finish'
  active: boolean
  placeholder: string
  value: string
  fieldRef?: React.RefObject<HTMLInputElement | null>
  onActivate: () => void
  onChange: (value: string) => void
  onClear: () => void
}) {
  return (
    <div className="search-row" data-active={active ? 'yes' : 'no'}>
      <span className="search-badge" data-role={role} aria-hidden="true">
        {role === 'start' ? 'S' : ''}
      </span>
      <input
        ref={fieldRef}
        type="search"
        className="search-field"
        // `search` gives iOS the clear affordance and the right keyboard; `off` on the rest,
        // because a route planner offering to autocomplete a street name from a form the rider
        // filled in on another site is both wrong and unsettling.
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="words"
        spellCheck={false}
        enterKeyHint="search"
        placeholder={placeholder}
        value={value}
        onFocus={onActivate}
        onChange={(event) => onChange(event.target.value)}
      />
      {active && value.length > 0 && (
        <button type="button" className="search-clear" onClick={onClear} aria-label="Clear">
          ×
        </button>
      )}
    </div>
  )
}

/**
 * What to say when nothing on the phone matches.
 *
 * Three different situations wear the same blank screen, and telling them apart is most of what
 * this component is: the index is still being built, the place exists but its region is not
 * downloaded, or there is genuinely no such place. Only the middle one has an action, and it is
 * the common one.
 */
function NothingHere({
  query,
  index,
  elsewhere,
  onOpenMaps,
  onChooseOnMap,
}: {
  query: string
  index: ReturnType<typeof useIndexState>
  elsewhere: GazetteerPlace[]
  onOpenMaps: () => void
  onChooseOnMap: () => void
}) {
  // Loaded only once there is somewhere to name, which is the only path that needs it: the
  // catalogue is a network fetch with a cached fallback, and the common case for this screen is
  // that the rider found what they were looking for.
  const catalogue = useCatalogue(elsewhere.length > 0)
  if (index.ready.length === 0) {
    return (
      <p className="warn">
        {index.building
          ? `Still reading the names out of your maps — ${Math.round(index.progress * 100)}%. This happens once per region.`
          : index.problem
            ? `The place index could not be built: ${index.problem}`
            : 'No maps on this phone yet, so there is nothing to search. Download a region in Setup.'}
      </p>
    )
  }

  const found = elsewhere[0]
  const region = found && catalogue ? regionAt(catalogue.manifest.regions, found.lon, found.lat) : null
  const haveIt = region ? catalogue!.installed.includes(region.id) : false
  /*
   * The whole download, not just the basemap.
   *
   * `region.basemap.bytes` is the map — 79 MB for North Wales — and the road data beside it is
   * the larger half. Quoting the smaller number under the words "map and road data" would be a
   * figure that is wrong in the direction a rider on a phone plan cares about. `downloadPlan`
   * against an empty installed list is the honest worst case: everything, sharing nothing.
   */
  const cost = region && catalogue ? downloadPlan(region, catalogue.manifest, []).bytes : 0

  if (found && region && !haveIt) {
    return (
      <div className="search-elsewhere">
        <p className="search-elsewhere-head">
          <WarnIcon />
          <span>
            <strong>Not in the maps on this phone</strong>
            <span>
              {found.name} is in {region.name}
            </span>
          </span>
        </p>
        <p>
          Free Wheel only searches regions you have downloaded, so it works with no signal. Add
          the region and {found.name} — plus every road in it — becomes searchable and routable.
        </p>
        <button
          type="button"
          className="search-download"
          onClick={() => {
            // `downloadStore` is a module singleton for exactly this: a rider can start a
            // download here and close the screen, and it carries on without the Maps screen
            // ever having been mounted.
            downloads.start(region, catalogue!.manifest, cost)
            onOpenMaps()
          }}
        >
          <DownIcon />
          <span>
            <strong>{region.name}</strong>
            <span>{Math.round(cost / 1e6)} MB · map and road data</span>
          </span>
        </button>
        <button type="button" className="picker-plain" onClick={onOpenMaps}>
          Or open the maps library
        </button>
      </div>
    )
  }

  return (
    <>
      <p className="warn">
        Nothing called “{query.trim()}” in the maps on this phone. Check the spelling, or drop a
        pin where you mean.
      </p>
      <ul className="place-list">
        <PlaceRow
          glyph="map"
          title="Choose on the map"
          detail="Drop a pin anywhere, address or not"
          onPick={onChooseOnMap}
        />
      </ul>
    </>
  )
}

/** Renaming a saved place. A text field, which is fine: this screen is never used on a bike. */
function RenamePlace({
  initial,
  onCancel,
  onSave,
}: {
  initial: string
  onCancel: () => void
  onSave: (name: string) => void
}) {
  const [name, setName] = useState(initial)
  return (
    <div className="setup-group">
      <label className="named-save">
        <span className="section-label">Call it something</span>
        <input
          type="text"
          value={name}
          autoFocus
          placeholder="Home"
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <div className="sheet-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="primary" onClick={() => onSave(name)}>
          Save
        </button>
      </div>
    </div>
  )
}

type RowGlyph = PlaceGlyph | PlaceIcon | 'locate' | 'map' | 'recent'

/**
 * One tappable place.
 *
 * The row is one button and the star beside it is another, which is the same rule the route
 * cards follow: an interactive element inside an interactive element is a target a screen
 * reader cannot describe and a keyboard cannot reach past.
 */
function PlaceRow({
  glyph,
  title,
  detail,
  away,
  match,
  saved,
  onSave,
  onPick,
  remove,
  rename,
  rideTo,
}: {
  glyph: RowGlyph
  title: string
  detail: string
  /** Metres from wherever the search was made, or null when that is unknown. */
  away?: number | null
  /** The typed text, bolded inside the name so a long list is scannable. */
  match?: string
  saved?: boolean
  onSave?: () => void
  onPick: () => void
  remove?: () => void
  rename?: () => void
  /** "From where I am to here", as one tap. Only where that can mean one thing. */
  rideTo?: () => void
}) {
  return (
    <li className="place-item">
      <button type="button" className="place-row" onClick={onPick}>
        <span className="place-glyph" aria-hidden="true">
          <Glyph name={glyph} />
        </span>
        <span className="place-text">
          <span className="place-name">{match ? highlight(title, match) : title}</span>
          <span className="place-detail">{detail}</span>
        </span>
        {away !== undefined && away !== null && (
          <span className="place-away">{formatAway(away)}</span>
        )}
      </button>
      {rename && (
        <button type="button" className="place-action" onClick={rename} aria-label={`Rename ${title}`}>
          <PencilIcon />
        </button>
      )}
      {remove && (
        <button
          type="button"
          className="place-action"
          onClick={remove}
          aria-label={`Remove ${title}`}
        >
          ×
        </button>
      )}
      {rideTo && (
        <button
          type="button"
          className="place-action place-go"
          onClick={rideTo}
          aria-label={`Ride to ${title} from where I am`}
        >
          <ArrowIcon />
        </button>
      )}
      {onSave && (
        <button
          type="button"
          className="place-action"
          data-on={saved ? 'yes' : 'no'}
          onClick={onSave}
          aria-pressed={saved}
          aria-label={saved ? `Forget ${title}` : `Save ${title}`}
        >
          <StarIcon filled={saved} />
        </button>
      )}
    </li>
  )
}

/**
 * The typed text, in bold, inside the name.
 *
 * Folded on both sides so it survives the punctuation and the accents the search itself ignores
 * — otherwise typing `st andrews` would match `St Andrew's Square` and then highlight nothing in
 * it, which reads as the wrong row having been returned.
 */
function highlight(name: string, query: string): React.ReactNode {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return name
  const at = name.toLowerCase().indexOf(needle)
  if (at === -1) return name
  return (
    <>
      {name.slice(0, at)}
      <b>{name.slice(at, at + needle.length)}</b>
      {name.slice(at + needle.length)}
    </>
  )
}

const coords = (point: { lat: number; lon: number } | null): string =>
  point ? `${point.lat.toFixed(4)}, ${point.lon.toFixed(4)}` : ''

const awayFrom = (
  near: { lon: number; lat: number } | null,
  point: { lon: number; lat: number },
): number | null => {
  if (!near) return null
  const scale = Math.cos((near.lat * Math.PI) / 180)
  const dx = (near.lon - point.lon) * scale * 111_320
  const dy = (near.lat - point.lat) * 111_320
  return Math.sqrt(dx * dx + dy * dy)
}

const formatAway = (metres: number): string =>
  metres < 1000 ? `${Math.round(metres / 10) * 10} m` : `${(metres / 1000).toFixed(1)} km`

/** "Central Scotland and one other region" — the source, named, because that is the promise. */
function describeSources(hits: SearchHit[]): string {
  const names = [...new Set(hits.map((hit) => prettyArchive(hit.archive)))]
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names[0]} and ${names.length - 1} other regions`
}

/** `central-scotland.pmtiles` is a file name; `Central Scotland` is what a rider downloaded. */
function prettyArchive(archive: string): string {
  return archive
    .replace(/\.pmtiles$/, '')
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/* Inline SVG rather than sprite lookups: a missing sprite entry would be one more thing that
   can fail silently offline. */

function Glyph({ name }: { name: RowGlyph }) {
  switch (name) {
    case 'town':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 20V9l5-3 5 3v11M14 20V12l6-2v10M4 20h16" />
          <path d="M8 13h2M8 16.5h2M17 14h1" />
        </svg>
      )
    case 'street':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9 3 5 21M15 3l4 18M12 5v3M12 11v3M12 17v3" />
        </svg>
      )
    case 'water':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 8c3-2 5 2 8 0s5-2 8 0M3 13c3-2 5 2 8 0s5-2 8 0M3 18c3-2 5 2 8 0s5-2 8 0" />
        </svg>
      )
    case 'hill':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 19 10 7l4 6 2-3 5 9z" />
        </svg>
      )
    case 'locate':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="7" />
          <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
          <path d="M12 1.5v3.5M12 19v3.5M22.5 12H19M5 12H1.5" />
        </svg>
      )
    case 'map':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 6.5 9 4l6 2.5L21 4v13.5L15 20l-6-2.5L3 20z" />
          <path d="M9 4v13.5M15 6.5V20" />
        </svg>
      )
    case 'recent':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7v5.5l3.5 2" />
        </svg>
      )
    case 'home':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 10.5 12 4l8 6.5V20H4z" />
          <path d="M10 20v-5h4v5" />
        </svg>
      )
    case 'work':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3.5 8h17v11h-17z" />
          <path d="M9 8V5.5h6V8" />
        </svg>
      )
    case 'star':
      return <StarIcon filled />
    default:
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 21s6.5-6.1 6.5-10.5a6.5 6.5 0 1 0-13 0C5.5 14.9 12 21 12 21z" />
          <circle cx="12" cy="10.4" r="2.4" />
        </svg>
      )
  }
}

function StarIcon({ filled }: { filled?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 3.6l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"
        fill={filled ? 'currentColor' : 'none'}
      />
    </svg>
  )
}

function ChevronLeftIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M15 5l-7 7 7 7" />
    </svg>
  )
}

function SwapIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 4v16M8 4 5 7.5M8 4l3 3.5M16 20V4M16 20l3-3.5M16 20l-3-3.5" />
    </svg>
  )
}

function DownIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 4v11M8 11.5l4 4 4-4M5 20h14" />
    </svg>
  )
}

function WarnIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5M12 16.2v.1" />
    </svg>
  )
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 20h4L19 9l-4-4L4 16z" />
    </svg>
  )
}

/**
 * The published regions, and which of them this phone holds.
 *
 * Both are needed only to answer one question — which region covers the town the rider typed —
 * so both are fetched lazily and a failure is silent: without them the screen falls back to
 * "nothing called that here", which is still true and still better than an error about a
 * manifest.
 */
function useCatalogue(wanted: boolean): { manifest: DataManifest; installed: string[] } | null {
  const [catalogue, setCatalogue] = useState<{
    manifest: DataManifest
    installed: string[]
  } | null>(null)

  useEffect(() => {
    if (!wanted || catalogue) return
    let live = true
    void (async () => {
      try {
        const [{ manifest }, installed] = await Promise.all([
          loadManifest(),
          sharedEngine().installedRegions(),
        ])
        if (live) setCatalogue({ manifest, installed: installed.map((region) => region.id) })
      } catch {
        // Offline with no cached manifest. The screen says nothing was found, which is true.
      }
    })()
    return () => {
      live = false
    }
  }, [wanted, catalogue])

  return catalogue
}

/** A route, drawn as an arrow leaving a dot: "from here, to there". */
function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="5.5" cy="12" r="2.2" />
      <path d="M9 12h9M14.5 8l4 4-4 4" />
    </svg>
  )
}
