import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

const required = (name) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set. See tools/mirror/README.md`)
  return value
}

export const BUCKET = required('S3_BUCKET')

export const client = new S3Client({
  endpoint: required('S3_ENDPOINT'),
  region: process.env.S3_REGION ?? 'eu-central-1',
  credentials: {
    accessKeyId: required('S3_ACCESS_KEY_ID'),
    secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
  },
  forcePathStyle: true,
})

/** Immutable because every object's name carries its content hash. */
export const IMMUTABLE = 'public, max-age=31536000, immutable'
/** The only mutable object. Five minutes is short enough that an update is noticed same-day. */
export const MANIFEST_CACHE = 'public, max-age=300'

export async function putObject(key, body, { contentType, cacheControl }) {
  await client.send(new PutObjectCommand({
    Bucket: BUCKET, Key: key, Body: body,
    ContentType: contentType, CacheControl: cacheControl,
  }))
  return key
}

export async function listKeys(prefix) {
  const keys = new Set()
  let token
  do {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: BUCKET, Prefix: prefix, ContinuationToken: token,
    }))
    for (const object of page.Contents ?? []) keys.add(object.Key)
    token = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (token)
  return keys
}

export async function readJson(key) {
  try {
    const result = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
    return JSON.parse(await result.Body.transformToString())
  } catch (error) {
    if (error?.name === 'NoSuchKey') return null
    throw error
  }
}
