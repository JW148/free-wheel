import { useEffect, useState } from 'react'
import { POSITIONS, TYRES, cdaOf, crrOf, totalMassKg } from '../ride/rider'
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
      <p className="step-note">
        Used to estimate power and effort while riding. Nothing here leaves the phone.
      </p>

      <div className="rider-masses">
        <label>
          <span className="section-label">You, in kg</span>
          <input
            type="number"
            inputMode="decimal"
            min={30}
            max={200}
            value={setup.riderKg}
            onChange={(e) => update({ riderKg: Number(e.target.value) || setup.riderKg })}
          />
        </label>
        <label>
          <span className="section-label">Bike and bags, in kg</span>
          <input
            type="number"
            inputMode="decimal"
            min={3}
            max={60}
            value={setup.bikeKg}
            onChange={(e) => update({ bikeKg: Number(e.target.value) || setup.bikeKg })}
          />
        </label>
      </div>

      <fieldset className="profiles">
        <legend className="section-label">How you sit</legend>
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

      <fieldset className="profiles">
        <legend className="section-label">What you are riding on</legend>
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

      <dl className="detail-stats">
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
      <p className="step-note">
        If those two numbers do not match what you know you can hold, the settings above are the
        thing to adjust. The estimate cannot see wind, a wet road, or your brakes — so it will
        read high on a descent and low into a headwind.
      </p>

      <h2>On the road</h2>
      <label className="switch-row">
        <input
          type="checkbox"
          checked={setup.autoReroute}
          onChange={(e) => update({ autoReroute: e.target.checked })}
        />
        <span>
          <strong>Reroute when I leave the route</strong>
          <span className="profile-note">
            Routes again from where you are, through whatever waypoints are still ahead. Turn it
            off if you would rather find your own way back to the line.
          </span>
        </span>
      </label>

      <h2>Storage</h2>
      <p className="step-note">
        {persisted === true
          ? 'This app’s data is marked persistent — the browser will not reclaim your maps and routing tiles under storage pressure.'
          : 'Browsers reclaim storage from sites under pressure, and a reclaimed basemap is discovered in airplane mode at the side of a road. Asking for persistence is usually granted for an app added to the Home Screen.'}
      </p>
      {persisted !== true && (
        <button type="button" onClick={() => void requestPersistence().then(setPersisted)}>
          Ask to keep my data
        </button>
      )}
    </section>
  )
}
