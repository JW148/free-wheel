import { useEffect, useState } from 'react'
import { MASS_LIMITS, POSITIONS, TYRES, cdaOf, crrOf, totalMassKg } from '../ride/rider'
import { estimatePowerW } from '../ride/power'
import { requestPersistence } from '../ride/library'
import type { Rider } from '../ride/useRider'

/**
 * The four numbers behind the power estimate, plus the two switches that are about the rider
 * rather than the map.
 *
 * ## Why the preview is here
 *
 * Because the settings are otherwise unfalsifiable. "CdA 0.40" means nothing to almost
 * everyone, and a rider has no way to tell whether they have picked well until they are out on
 * a hill wondering why the number looks wrong. Showing what the current setup predicts for two
 * familiar situations — 25 km/h on the flat, and 10 km/h up 8% — turns an abstract choice into
 * one that can be checked against experience. A rider who knows they hold about 200 W on a
 * climb can see immediately whether the model agrees.
 *
 * It is also the only loud thing on this screen, and that is deliberate: it is the one element
 * here worth looking at rather than reading.
 *
 * ## Why it says what it cannot do
 *
 * Every estimate here is blind to wind, brakes, a wet road and a rucksack. Saying so once, in
 * the place where the settings are, is what earns the right to show a bare watts figure on the
 * riding screen with only a tilde next to it.
 */
export default function RiderPanel({ rider }: { rider: Rider }) {
  const { setup, update } = rider
  const [persisted, setPersisted] = useState<boolean | null>(null)

  useEffect(() => {
    void navigator.storage?.persisted?.().then(setPersisted, () => setPersisted(null))
  }, [])

  const preview = (speedKmh: number, grade: number) =>
    Math.round(
      estimatePowerW({
        speedMps: speedKmh / 3.6,
        grade,
        massKg: totalMassKg(setup),
        cdaM2: cdaOf(setup),
        crr: crrOf(setup),
      }) / 5,
    ) * 5

  return (
    <section className="panel-block">
      <h2>You and the bike</h2>

      <h3>Weight</h3>
      <div className="setup-group">
        <Mass
          label="You"
          value={setup.riderKg}
          limits={MASS_LIMITS.riderKg}
          onCommit={(riderKg) => update({ riderKg })}
        />
        <Mass
          label="Bike and bags"
          value={setup.bikeKg}
          limits={MASS_LIMITS.bikeKg}
          onCommit={(bikeKg) => update({ bikeKg })}
        />
      </div>

      {/* The radio groups keep the drawer's own row treatment, so a choice made here looks like
          a choice made there. */}
      <h3>How you sit</h3>
      <fieldset className="profiles">
        {POSITIONS.map((option) => (
          <div
            key={option.id}
            className="profile-row"
            data-selected={setup.position === option.id ? 'yes' : 'no'}
          >
            <input
              id={`position-${option.id}`}
              type="radio"
              name="position"
              checked={setup.position === option.id}
              onChange={() => update({ position: option.id })}
            />
            <label htmlFor={`position-${option.id}`} className="profile-text">
              <span className="profile-label">{option.label}</span>
              <span className="profile-note">{option.note}</span>
            </label>
          </div>
        ))}
      </fieldset>

      <h3>What you are riding on</h3>
      <fieldset className="profiles">
        {TYRES.map((option) => (
          <div
            key={option.id}
            className="profile-row"
            data-selected={setup.tyres === option.id ? 'yes' : 'no'}
          >
            <input
              id={`tyres-${option.id}`}
              type="radio"
              name="tyres"
              checked={setup.tyres === option.id}
              onChange={() => update({ tyres: option.id })}
            />
            <label htmlFor={`tyres-${option.id}`} className="profile-text">
              <span className="profile-label">{option.label}</span>
              <span className="profile-note">{option.note}</span>
            </label>
          </div>
        ))}
      </fieldset>

      <h3>What that adds up to</h3>
      <dl className="rider-preview">
        <div>
          <dd>{preview(25, 0)} W</dd>
          <dt>25 km/h, flat</dt>
        </div>
        <div>
          <dd>{preview(10, 0.08)} W</dd>
          <dt>10 km/h, up 8%</dt>
        </div>
        <div>
          <dd>{totalMassKg(setup)} kg</dd>
          <dt>all in</dt>
        </div>
      </dl>
      <p className="setup-footer">
        If those watts do not match what you know you can hold, the settings above are the thing
        to adjust. The estimate cannot see wind, a wet road or your brakes, so it reads high on a
        descent and low into a headwind. Nothing here leaves the phone.
      </p>

      <h2>On the road</h2>
      <div className="setup-group">
        <label className="setup-row switch-row">
          <span className="setup-row-text">
            <span className="setup-row-label">Reroute when I leave the route</span>
            <span className="setup-row-note">
              Routes again from where you are, through the waypoints still ahead.
            </span>
          </span>
          <input
            type="checkbox"
            checked={setup.autoReroute}
            onChange={(e) => update({ autoReroute: e.target.checked })}
          />
        </label>
      </div>
      <p className="setup-footer">
        Turn it off if you would rather find your own way back to the line.
      </p>

      <h2>Storage</h2>
      <div className="setup-group">
        <div className="setup-row">
          <span className="setup-row-text">
            <span className="setup-row-label">Keep my maps and road data</span>
            <span className="setup-row-note">
              {persisted === true
                ? 'Granted. The browser will not reclaim your downloads under storage pressure.'
                : 'Not granted yet. Usually allowed for an app added to the Home Screen.'}
            </span>
          </span>
          {persisted === true ? (
            <span className="setup-value">
              <strong>On</strong>
            </span>
          ) : (
            <button type="button" onClick={() => void requestPersistence().then(setPersisted)}>
              Ask
            </button>
          )}
        </div>
      </div>
      <p className="setup-footer">
        Browsers reclaim storage from sites under pressure, and a reclaimed basemap is discovered
        in airplane mode at the side of a road.
      </p>
    </section>
  )
}

/**
 * A mass field that clamps when you leave it, not while you are typing.
 *
 * `migrateRider` clamps on load, so an out-of-range value typed here used to skew the power
 * model for the whole session and then silently change on the next launch. Clamping on every
 * keystroke instead is worse: typing "5" on the way to "55" would snap the field to the 30 kg
 * floor and the next keystroke would produce "305".
 *
 * So the field holds its own text while focused and commits a clamped number on blur. `min`
 * and `max` stay on the input for the numeric keyboard and for assistive technology.
 *
 * The unit lives beside the field rather than in the label ("You, in kg"), so the label says
 * what the setting is and the row says what the number means — which is how every other row on
 * this screen reads.
 */
function Mass({
  label,
  value,
  limits,
  onCommit,
}: {
  label: string
  value: number
  limits: readonly [number, number]
  onCommit: (value: number) => void
}) {
  const [text, setText] = useState<string | null>(null)

  const commit = () => {
    const parsed = Number(text)
    setText(null)
    if (text === null || text.trim() === '' || !Number.isFinite(parsed)) return
    onCommit(Math.min(Math.max(parsed, limits[0]), limits[1]))
  }

  return (
    <label className="setup-row">
      <span className="setup-row-text">
        <span className="setup-row-label">{label}</span>
      </span>
      <span>
        <input
          type="number"
          inputMode="decimal"
          min={limits[0]}
          max={limits[1]}
          value={text ?? String(value)}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
        <span className="setup-unit">kg</span>
      </span>
    </label>
  )
}
