/**
 * Where the app's data lives.
 *
 * A committed constant rather than an environment variable: `vercel.json` is a static build
 * with no env vars, and the bucket is public anyway. Changing hosts is a one-line commit.
 *
 * The live bucket: Hetzner Object Storage, Falkenstein, in virtual-hosted form
 * (`<bucket>.<location>.your-objectstorage.com`). Deliberately not the path-style
 * `S3_ENDPOINT` the mirror scripts sign against — both address the same bucket, and this is
 * the one a browser reads. Verified 2026-09-11 with a ranged request returning `206` plus
 * `access-control-allow-origin` and `content-range`; re-check with the `curl` in
 * `web/tools/mirror/README.md` if the picker ever reports it cannot reach the internet.
 */
export const DATA_ORIGIN = 'https://free-wheel.fsn1.your-objectstorage.com'

export const MANIFEST_URL = `${DATA_ORIGIN}/manifest.json`

/** Turns a manifest-relative path into a fetchable URL. */
export const assetUrl = (path: string) => `${DATA_ORIGIN}/${path}`
