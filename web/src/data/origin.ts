/**
 * Where the app's data lives.
 *
 * A committed constant rather than an environment variable: `vercel.json` is a static build
 * with no env vars, and the bucket is public anyway. Changing hosts is a one-line commit.
 *
 * This is the Hetzner Object Storage endpoint form the bucket will use, but the bucket itself
 * does not exist yet — it is created in a separate task, blocked on credentials. Set this to
 * the real endpoint once that bucket exists, and confirm with `curl -sI "$MANIFEST_URL" | head -1`
 * expecting `HTTP/2 200`.
 */
export const DATA_ORIGIN = 'https://free-wheel.fsn1.your-objectstorage.com'

export const MANIFEST_URL = `${DATA_ORIGIN}/manifest.json`

/** Turns a manifest-relative path into a fetchable URL. */
export const assetUrl = (path: string) => `${DATA_ORIGIN}/${path}`
