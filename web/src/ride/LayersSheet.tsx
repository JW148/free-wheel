import { Drawer } from 'vaul'
import { nextPathMode, type MapTheme, type PathMode } from '../map/style'

/**
 * What the map looks like: daylight or dark, which paths are drawn, whether it follows you.
 *
 * ## Why these three left the rail
 *
 * The rail had seven buttons and a chevron to fold them away, which is a control for a control.
 * Two of those seven were waypoint placing and the saved list — both now somewhere better — and
 * three were these, which have one thing in common: **you set them and then you do not touch
 * them again.** A button on the rail is for something you reach for at a junction. A map
 * preference is not that, and spending a permanent 46 px of a phone's screen on each was the
 * rail's whole problem.
 *
 * What is left on the map is Locate and this. Two buttons, neither of which needs a chevron.
 *
 * ## Why it is rows and not a grid of icons
 *
 * Path mode has three states and daylight has two, and neither is guessable from a glyph — the
 * old rail needed a sentence in its `aria-label` to explain what a forking dashed line meant.
 * A row can say it in words and show the state beside it, which is what a sheet is for.
 *
 * ## And the door to Setup, because it has to be somewhere
 *
 * Setup was reachable from the plan card's shortcuts and *only* from there — which meant it
 * vanished the moment a rider placed a point, and stayed gone for as long as they had a route
 * on the map. A rider part-way through planning who runs out of downloaded region cannot get
 * to the regions without clearing the plan first, which is exactly backwards.
 *
 * So it goes here. This is the only surface on the ride screen that already holds things you
 * set rather than things you do, and it is behind one of the two buttons that never leave the
 * map. It is a door rather than a setting, so it sits below the note that closes the map
 * group instead of pretending to be a fourth row of it.
 */
export default function LayersSheet({
  open,
  onOpenChange,
  theme,
  onTheme,
  pathMode,
  onPathMode,
  follow,
  onFollow,
  onOpenSetup,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  theme: MapTheme
  onTheme: (theme: MapTheme) => void
  pathMode: PathMode
  onPathMode: (mode: PathMode) => void
  follow: boolean
  onFollow: (follow: boolean) => void
  onOpenSetup: () => void
}) {
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="drawer-overlay" />
        <Drawer.Content className="drawer" aria-describedby={undefined}>
          <Drawer.Handle className="drawer-handle" />
          <div className="drawer-body">
            <div className="drawer-head">
              <Drawer.Title className="drawer-title">Map</Drawer.Title>
            </div>

            <div className="setup-group">
              <button
                type="button"
                className="setup-row"
                onClick={() => onTheme(theme === 'dark' ? 'light' : 'dark')}
              >
                <span className="setup-row-text">
                  <span className="setup-row-label">Daylight map</span>
                  <span className="setup-row-note">
                    The chrome follows the map, so both change together.
                  </span>
                </span>
                <Switch on={theme === 'light'} />
              </button>

              <button type="button" className="setup-row" onClick={() => onPathMode(nextPathMode(pathMode))}>
                <span className="setup-row-text">
                  <span className="setup-row-label">Paths</span>
                  <span className="setup-row-note">{PATH_MODE_NOTE[pathMode]}</span>
                </span>
                <span className="setup-value">{PATH_MODE_VALUE[pathMode]}</span>
              </button>

              <button type="button" className="setup-row" onClick={() => onFollow(!follow)}>
                <span className="setup-row-text">
                  <span className="setup-row-label">Follow me</span>
                  <span className="setup-row-note">
                    Keeps the map centred on your position while you plan.
                  </span>
                </span>
                <Switch on={follow} />
              </button>
            </div>

            <p className="setup-footer">
              Paths and the daylight map are remembered. Following is not — it is a thing you do
              for a minute, not a setting.
            </p>

            {/* Closed on the way out rather than left open underneath: Setup covers this sheet
                whole, and coming back out of it onto a drawer nobody asked for again reads as
                the app having lost its place. */}
            <div className="setup-group">
              <button
                type="button"
                className="setup-row"
                onClick={() => {
                  onOpenChange(false)
                  onOpenSetup()
                }}
              >
                <span className="setup-row-text">
                  <span className="setup-row-label">Setup</span>
                  <span className="setup-row-note">
                    The regions on this phone, you and the bike, diagnostics.
                  </span>
                </span>
                <ChevronRightIcon />
              </button>
            </div>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}

/**
 * Names the state the map is *in*, not the one the next tap moves to.
 *
 * The map already shows the change, so a label describing the next tap reads as a
 * contradiction of what you can see.
 */
const PATH_MODE_VALUE: Record<PathMode, string> = {
  rideable: 'Rideable',
  all: 'All',
  none: 'Hidden',
}

const PATH_MODE_NOTE: Record<PathMode, string> = {
  rideable: 'Cycleways, tracks and bridleways.',
  all: 'Including footpaths, steps and crossings.',
  none: 'No paths drawn at all.',
}

/** Purely visual — the row it sits in is the button, and carries the semantics. */
function Switch({ on }: { on: boolean }) {
  return <span className="switch" data-on={on ? 'yes' : 'no'} aria-hidden="true" />
}

/** The same chevron Setup's own menu rows carry, so a row that pushes looks like one. */
function ChevronRightIcon() {
  return (
    <svg viewBox="0 0 24 24" className="library-chevron" aria-hidden="true">
      <path d="M9 5l7 7-7 7" />
    </svg>
  )
}
