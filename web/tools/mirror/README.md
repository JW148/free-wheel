# The mirror

There is no backend (see the top-level `CLAUDE.md`). This directory is the one exception: two
scripts that run under plain Node on your own machine, not in the app, and fill an
S3-compatible bucket with the data the app streams from. They are the only thing in this project
that ever talks to `brouter.de`, and at roughly eight conditional requests per refresh — one
per distinct BRouter segment Britain's regions need (`regions.test.mjs` asserts each region
needs at most two, and `regions.json` currently has 14 regions overlapping onto a small shared
set of grid cells).

Nothing under `web/src` reads these scripts or their dependencies at build time. They exist
purely to keep the bucket current; the app only ever reads `manifest.json` and the objects it
names, over plain HTTPS, and has no environment variables of its own.

## What the two jobs do

- **`sync-segments.mjs`** (the cheap one): for every BRouter segment any region needs, makes a
  conditional request to `brouter.de/brouter/segments4/`, and republishes it under a
  content-addressed name only if the bytes actually differ from what is already mirrored.
  `brouter.de` rebuilds every segment's file weekly regardless of whether the underlying map
  data changed, so comparing hashes rather than trusting `Last-Modified` is what stops a rider
  being told to re-download 137 MB of nothing new (`lib/decide.mjs`).
- **`cut-basemaps.mjs`** (the expensive one): re-cuts the picker's UK-wide backdrop and each
  region's street-level basemap from a dated Protomaps build, and republishes whichever ones
  changed. Run it far less often than the segment sync: a Protomaps daily build's bytes churn on
  almost every extract regardless of content, so hashing does not damp this the way it damps
  segments — an 86 MB re-download is not worth offering because a cafe moved.

Both scripts end by writing a single `manifest.json`, which is the one document
`web/src/data/manifest.ts` fetches and the one the app's `parseManifest` validates strictly
against. Read that parser before changing either script's output shape: version must be `1`,
every asset needs a positive `bytes` and (except the picker) a `hash`, segment keys must match
the BRouter grid pattern, region ids must be lowercase-digits-hyphens, and every segment a
region lists must be described in the manifest's own `segments` map. A manifest that fails that
parser is worse than no manifest — see "Ordering" below for why the write is always last.

## Ordering: `cut-basemaps.mjs` must run before `sync-segments.mjs` ever has

On a brand new bucket there is no `manifest.json` yet, so nothing has been mirrored at all.
`sync-segments.mjs` reads the current manifest to find each region's *basemap* (it never cuts
one itself), and a region with none is left out of the manifest it writes, named on stdout. If
*no* region has one — the brand new bucket — it refuses the run outright, because a manifest
with no regions would replace a good one with an empty picker. So `cut-basemaps.mjs` has to run
first, at least once, before `sync-segments.mjs` can ever publish anything.

Leaving one region out rather than failing the whole run matters after the first time too:
adding a region to `regions.json` used to stop *every* region's routing-data update until
`cut-basemaps` next ran, which may be months. The new region's segments are mirrored by
`sync-segments.mjs` regardless — the wanted-segment list is computed from every region in
`regions.json` — so whenever `cut-basemaps.mjs` next runs it finds them waiting and publishes
the region complete.

`cut-basemaps.mjs` itself only ever publishes a region into `manifest.json` once every BRouter
segment that region needs is *also* already mirrored (`lib/manifest.mjs`'s `buildManifest`
enforces this for every caller, and is tested doing so — a manifest must never name a segment
the bucket does not have). On the very first run, or the moment a new region is added to
`regions.json`, that is not yet true for any region. `cut-basemaps.mjs` handles this by
publishing those regions anyway, with an empty `segments` list and a log line naming them —
never with a segment list `buildManifest` has not verified.

**That manifest is one the app deliberately rejects.** `parseManifest` refuses a region with an
empty `segments` list, because a phone that accepted one would price the region as
basemap-only, download it, record it, and then report it as current with nothing for BRouter to
route on. So a manifest written by `cut-basemaps.mjs` alone is a bucket-side stepping stone,
not something to leave up: a phone fetching it falls back to its cached copy, or fails saying
so. Run `mirror:segments` immediately afterwards — it fills every region in on the same pass
and republishes a manifest the app accepts. On every run after the first, both scripts see a
bucket that already has everything the other one needs, and this whole section is a no-op.

Bootstrap a brand new bucket in this order:

```bash
cd web
export S3_ENDPOINT=... S3_REGION=... S3_BUCKET=... S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=...
npm run mirror:configure              # CORS and public-read — see below
npm run mirror:basemaps -- 20260906   # picks a build date — see below
npm run mirror:segments
```

## Environment variables

Read only by `s3.mjs`, on whichever machine you run the scripts from. The app itself has none —
it only ever does plain, unauthenticated `fetch()` calls against the public bucket URL.

| Variable | Meaning |
|---|---|
| `S3_ENDPOINT` | The S3-compatible endpoint, e.g. Hetzner Object Storage's regional URL. |
| `S3_REGION` | Defaults to `eu-central-1` if unset. |
| `S3_BUCKET` | The bucket name. |
| `S3_ACCESS_KEY_ID` | Access key with read/write/list on that bucket. |
| `S3_SECRET_ACCESS_KEY` | Its secret. |

Missing any of them fails fast with a message pointing back at this file, rather than a raw SDK
error partway through a run.

## The Protomaps build date

`cut-basemaps.mjs <YYYYMMDD>` pulls from `https://build.protomaps.com/<YYYYMMDD>.pmtiles`.
These are dated daily builds and they expire — `20260801` already 404s by the time this was
written, so do not reuse a date from an old log or an old commit. Find a live one right before
running the job:

```bash
for days_ago in 0 1 2 3 4 5 6; do
  d=$(date -u -v-${days_ago}d +%Y%m%d)        # BSD date, i.e. macOS; GNU is -d "-${days_ago} days"
  if curl -sfI "https://build.protomaps.com/${d}.pmtiles" > /dev/null; then echo "$d"; break; fi
done
```

Pass whatever date that prints as the argument to `npm run mirror:basemaps`. Running this by
hand is the reason the date is never wrong: the appendix's cron line guesses
`<current-year><current-month>01` instead, and Protomaps is not guaranteed to have published
that day's build by the time it fires.

## CORS and public-read

Both are applied by `npm run mirror:configure`, which takes the origins to allow and defaults
to any (`npm run mirror:configure -- https://example.app` to be strict — but note a dev server
is its own origin, so a list naming only the deployed site breaks local testing). It is an S3
API call rather than a console setting because Hetzner's console does not offer CORS at all,
and it reads both settings back afterwards rather than trusting the writes.

**Public-read is the half that is easy to forget.** `putObject` sets no per-object ACL, so the
bucket's own policy is the only thing making the data readable. Without it every object is a
403, which presents in the app exactly like a bucket that does not exist: the picker reports
"could not reach the internet". If a provider refuses the bucket policy, the script says so
and the bucket has to be made public some other way before anything works.

The picker streams the UK-wide basemap with ranged reads, and every basemap and segment
download resumes from a byte offset (`web/src/engine/...` — see `CLAUDE.md`'s downloader
notes). None of that works unless the bucket's CORS rule allows `Range` in and exposes the
response headers a ranged read needs back out. As bucket configuration, not prose:

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": ["https://free-wheel.vercel.app"],
      "AllowedMethods": ["GET", "HEAD"],
      "AllowedHeaders": ["Range"],
      "ExposeHeaders": ["Content-Range", "Content-Length", "Accept-Ranges", "ETag"],
      "MaxAgeSeconds": 3600
    }
  ]
}
```

Replace `AllowedOrigins` with wherever the PWA is actually deployed. A wildcard (`"*"`) is also
fine here: everything in this bucket is public, unauthenticated, content-addressed data with no
cookies or credentials involved, so being permissive about the calling origin does not expose
anything a direct `curl` of the same URL would not.

If `Content-Range` is missing from a response, the streamed picker cannot work — it will read
as a hang or a full-archive download rather than an error. Resumable downloads degrade rather
than break: `downloadInto` cannot place a `206` whose `Content-Range` it cannot read, so it
asks again with no `Range` header and takes the whole file, discarding whatever had already
come down. Every interrupted download then restarts from zero, which for a 137 MB segment is
worth fixing in the bucket rather than living with. Verify with (needs a live bucket and
the real public URL, so this is unrun until then):

```bash
curl -sI -H 'Origin: https://free-wheel.vercel.app' -H 'Range: bytes=0-99' \
  "$BUCKET_PUBLIC_URL/manifest.json" | grep -i 'access-control\|content-range\|accept-ranges'
```

Expect `access-control-allow-origin`, `content-range: bytes 0-99/...` and `accept-ranges:
bytes`. Missing `content-range` means `AllowedHeaders` needs `Range` added before anything else
here is worth checking.

## Cache headers

- **Content-addressed objects** (`segments4/*.rd5`, `regions/*.pmtiles`, `basemap/*.pmtiles`) —
  `public, max-age=31536000, immutable`. Every one of these object names carries its own content
  hash, so the bytes behind a given URL never change; a client that has it never needs to ask
  again.
- **`manifest.json`** — `public, max-age=300`. It is the one mutable object in the bucket. Five
  minutes is short enough that a fresh mirror run is noticed the same day, long enough that a
  rider re-opening the app repeatedly does not re-fetch it every time.

Both are exported from `s3.mjs` as `IMMUTABLE` and `MANIFEST_CACHE` so the two scripts cannot
disagree about which is which.

## Refreshing the mirror

**Nothing is scheduled.** Both scripts run from your own machine, when you decide the data is
worth refreshing. There is no VPS, no cron and no log to check — an appendix at the end of this
file keeps the cron lines for whoever wants to automate it later.

Refreshing the routing data is the cheap half, and the one worth doing more often:

```bash
cd web
export S3_ENDPOINT=... S3_REGION=... S3_BUCKET=... S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=...
npm run mirror:segments
```

Eight conditional requests to `brouter.de`, and an upload only for segments whose bytes
actually differ. Most runs publish nothing at all, which is the point of `lib/decide.mjs`.

Refreshing the basemaps is the expensive half. Find a live Protomaps build date first (the loop
above), then:

```bash
npm run mirror:basemaps -- 20260906
npm run mirror:segments
```

Always run `mirror:segments` straight after `mirror:basemaps`, even though it is usually a
no-op: if you added a region to `regions.json` since the last basemap cut, the manifest
`cut-basemaps.mjs` just wrote is one the app deliberately rejects, and only `sync-segments.mjs`
fills the new region in. See "Ordering" above.

**What that second command costs on a laptop:** fifteen `pmtiles extract` runs, each reading
ranges out of a 137 GB remote archive, then roughly 1.8 GB uploaded to the bucket. It is bounded
by your broadband, not by the scripts, and the first run is the worst one. Budget an evening for
it and minutes for a segment sync.

**How often is often enough?** Monthly-ish for segments, once or twice a year for basemaps.
Running either more often mostly produces no-ops: a rider is only ever offered a re-download
when the bytes actually differ, so a refresh that changes nothing changes nothing on the phone
either. Going much longer is safe but visible — riders keep routing on the data they have, and
are simply never told an update exists.

## What is not done here

Writing these scripts is not the same as running them. Nobody who wrote this code has bucket
credentials, and the first real upload plus the CORS check against a live bucket are the
repo owner's to run — see the commands in "Ordering" and "CORS" above. Once that first run
succeeds, `web/src/data/origin.ts`'s `DATA_ORIGIN` (currently a placeholder) needs updating to
the real bucket's public URL.

## Appendix: automating it later

Not installed anywhere, and deliberately so — nothing owns these credentials but your machine.
If that ever changes, these are the two lines, and the caveat that comes with them:

```cron
17 4 * * 1   cd /srv/free-wheel/web && npm run mirror:segments >> /var/log/free-wheel-mirror.log 2>&1
41 3 1 * *   cd /srv/free-wheel/web && npm run mirror:basemaps -- $(date +\%Y\%m01) >> /var/log/free-wheel-mirror.log 2>&1
```

Weekly on Mondays, monthly on the 1st. The monthly line is not self-healing: it guesses the 1st
of the current month as the build date rather than searching for a live one, and Protomaps is
not guaranteed to have published that day's build by 03:41. When it hasn't, `pmtiles extract`
fails, the whole run fails loudly (see "no retry" in `cut-basemaps.mjs`'s own header comment),
and the manifest is not republished that month. That failure is silent unless someone reads
`/var/log/free-wheel-mirror.log` — which is the main thing running it by hand buys you.
