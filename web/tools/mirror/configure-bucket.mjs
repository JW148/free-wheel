/**
 * Applies the bucket's CORS rule and public-read policy, then reads both back.
 *
 * Neither is something the app can do for itself, and neither is reliably exposed in a
 * provider's web console — Hetzner's does not offer CORS at all — so they are S3 API calls,
 * kept here as configuration-as-code rather than as prose in the README that someone has to
 * translate into clicks.
 *
 * Both settings are load-bearing and fail in ways that look like something else:
 *
 * - **Without the policy**, every object is private. The app's `fetch` gets a 403, which
 *   presents exactly like a missing bucket: the picker shows "could not reach the internet".
 *   `putObject` deliberately sets no per-object ACL, so the bucket's own policy is the only
 *   thing making the data readable.
 * - **Without `ExposeHeaders`**, a browser cannot read `Content-Range` off a ranged response
 *   even when the server sends it. The streamed picker stops working, and every interrupted
 *   download restarts from zero instead of resuming — a 137 MB segment re-fetched in full.
 *
 * Idempotent: both calls replace whatever was there. Safe to re-run after changing origins.
 *
 * Usage:
 *   npm run mirror:configure                              # allows any origin
 *   npm run mirror:configure -- https://example.app       # allows exactly these origins
 */
import {
  GetBucketCorsCommand,
  GetBucketPolicyCommand,
  PutBucketCorsCommand,
  PutBucketPolicyCommand,
} from '@aws-sdk/client-s3'
import { BUCKET, client } from './s3.mjs'

const origins = process.argv.slice(2)
const allowedOrigins = origins.length > 0 ? origins : ['*']

// A wildcard is fine here and is the default: every object in this bucket is public,
// unauthenticated, content-addressed data with no cookies or credentials involved, so being
// permissive about the calling origin exposes nothing a direct curl of the same URL would not.
// Pass origins explicitly if you would rather be strict — but remember a dev server is its own
// origin, so a list that names only the deployed site will break local testing.
const corsRule = {
  AllowedOrigins: allowedOrigins,
  AllowedMethods: ['GET', 'HEAD'],
  AllowedHeaders: ['Range'],
  ExposeHeaders: ['Content-Range', 'Content-Length', 'Accept-Ranges', 'ETag'],
  MaxAgeSeconds: 3600,
}

const publicRead = {
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'PublicReadGetObject',
      Effect: 'Allow',
      Principal: '*',
      Action: ['s3:GetObject'],
      Resource: [`arn:aws:s3:::${BUCKET}/*`],
    },
  ],
}

const say = (label, value) => console.log(`${label}: ${JSON.stringify(value, null, 2)}`)

await client.send(new PutBucketCorsCommand({
  Bucket: BUCKET,
  CORSConfiguration: { CORSRules: [corsRule] },
}))
console.log(`CORS applied to ${BUCKET} for ${allowedOrigins.join(', ')}`)

try {
  await client.send(new PutBucketPolicyCommand({
    Bucket: BUCKET,
    Policy: JSON.stringify(publicRead),
  }))
  console.log(`public-read policy applied to ${BUCKET}`)
} catch (error) {
  // Some S3-compatible providers refuse bucket policies and expose a "public" switch in their
  // console instead. That is survivable, but it has to be done some other way before the app
  // can read anything, so fail loudly rather than leaving a private bucket looking configured.
  console.error(
    `\ncould not set the public-read policy: ${error?.name ?? 'error'} — ${error?.message ?? error}\n` +
      `CORS is applied, but the objects are unreadable until the bucket is public.\n` +
      `Set it in the provider's console, then re-run the verification below.`,
  )
}

// Read both back rather than trusting the writes: a provider that silently ignores one of
// these leaves a bucket that looks configured and serves 403s to the app.
const applied = await client.send(new GetBucketCorsCommand({ Bucket: BUCKET }))
say('CORS now reads back as', applied.CORSRules)

try {
  const policy = await client.send(new GetBucketPolicyCommand({ Bucket: BUCKET }))
  say('policy now reads back as', JSON.parse(policy.Policy))
} catch (error) {
  console.error(`could not read the policy back: ${error?.name ?? 'error'}`)
}

console.log(
  `\nVerify from a browser's point of view once an object exists:\n` +
    `  curl -sI -H 'Origin: https://example.app' -H 'Range: bytes=0-99' \\\n` +
    `    "$BUCKET_PUBLIC_URL/manifest.json" | grep -i 'access-control\\|content-range\\|accept-ranges'\n` +
    `Expect 206, access-control-allow-origin, and content-range among the headers.`,
)
