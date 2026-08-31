#!/usr/bin/env node
/**
 * Mirrors the vendored catalogue's illustrations into this deployment's R2 bucket.
 *
 * ## Why mirror rather than hotlink
 *
 * RepDB serves the same WebPs from its own CDN, and pointing `<img src>` at that CDN would
 * be one line instead of this file. It is the wrong line. This app is a PWA whose entire
 * claim is that it works at a trailhead with no signal, and a third-party origin sits
 * *outside* the service worker's reach — an uncacheable dependency on somebody else's
 * uptime, in exactly the moment the app is meant to still work. It would also tell that
 * origin which exercises which athlete is looking at. So the bytes are copied here once,
 * and `/api/exercises/img/…` is the only way back out.
 *
 * ## Bytes, verbatim
 *
 * RepDB Free Tier licence term 4 permits resizing, cropping and recolouring for in-app use,
 * and term 5 forbids generative-AI derivation *in any form* — no restyling, no upscaling,
 * no background removal, not as training data and not as conditioning input. This script
 * therefore does exactly one thing to each file: it checks the RIFF/WEBP magic and uploads
 * it unchanged. There is no image pipeline here to grow one, and that is deliberate.
 *
 * ## Where the bytes go
 *
 * `exercises/<CATALOG_VERSION>/<id>/<pose>.webp` in the **existing `AVATARS` bucket**. Not
 * a new bucket: a second binding is a second thing every fork and the live deployment must
 * create before the feature works, for zero isolation gain — both stores are reachable only
 * through this Worker's own routes, and the key namespaces cannot collide
 * (`avatars/<userId>/…` against `exercises/<version>/…`). The app has one bucket the way it
 * has one Worker. Keyed by exercise **id**, never by source path: twelve source files are
 * shared between variation aliases in RepDB's tree, so a path is not an identity — those
 * twelve are uploaded twice, under each id, for ~196 KB.
 *
 * One snapshot, one download: the whole repository tarball rather than 1,020 CDN fetches,
 * and the tarball's own `exercises.json` must hash to the `sourceSha256` in the committed
 * `catalog.json`. Images and metadata that came from different releases would be a
 * catalogue whose ids quietly point at the wrong pictures.
 *
 * `premium-samples/` in that tarball is evaluation-only (licence term 6) and is never read.
 *
 * ## Usage
 *
 *   pnpm exercises:populate                  # → the real bucket
 *   pnpm exercises:populate:local            # → .wrangler/state, what `pnpm dev`/`preview` read
 *   pnpm exercises:populate -- --dir ./repdb # an already-extracted checkout
 *   pnpm exercises:populate -- --tarball a.tar.gz
 *   pnpm exercises:populate -- --delete 9da2972b   # drop a superseded generation
 *
 * 1,020 objects, ~16 MB, once per catalogue refresh. Wrangler's process startup dominates;
 * budget 15–40 minutes and run it **before** deploying the build that compiles the new
 * version in, or the live Worker answers 404 for every illustration until it lands (it
 * self-heals, but the runbook says the order for a reason).
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TARBALL_URL = 'https://codeload.github.com/RepDB/exercise-dataset/tar.gz/refs/heads/main'

/**
 * Wrangler starts a fresh process per object, so the pool below is what makes 1,020 of
 * them finish in minutes rather than in half an hour.
 *
 * Eight against the real bucket: those are eight HTTP calls to R2 and it is nowhere near
 * anything's limit. **One against local storage**, and that is not caution — every local
 * `wrangler r2 object put` boots its own miniflare over the *same* `.wrangler/state`
 * directory, and concurrent ones knock each other over ("Network connection lost", about
 * 6% of objects when this ran at eight). One process at a time is the only arrangement
 * that store supports; it costs a `--local` populate about twenty minutes, once.
 */
const CONCURRENCY = { remote: 8, local: 1 }

/** Wrangler against remote R2 is flaky in bursts (AGENTS gotcha 13 says the same about
 *  `d1 execute --file`), and a local miniflare that lost a race recovers on the next try. */
const ATTEMPTS = 3

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CATALOG_PATH = resolve(root, 'src/lib/exercises/catalog.json')
const WRANGLER_PATH = resolve(root, 'wrangler.jsonc')

const fail = (message) => {
  console.error(`exercises:populate — ${message}`)
  process.exit(1)
}

const flag = (name) => process.argv.includes(`--${name}`)
const arg = (name) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? null : process.argv[at + 1]
}

const local = flag('local')
const force = flag('force')
const dryRun = flag('dry-run')

// ---------------------------------------------------------------------------
// What to upload: the committed catalogue, and nothing the catalogue does not name.
// ---------------------------------------------------------------------------

if (!existsSync(CATALOG_PATH)) fail('src/lib/exercises/catalog.json is missing — run `pnpm exercises:prune`')
const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'))

/**
 * The bucket name comes out of `wrangler.jsonc`'s own AVATARS entry rather than being
 * typed here, so a fork that renamed its bucket does not have to remember this file too.
 * A regex and not a JSONC parser: the file has comments, and adding a dependency to read
 * one string would be a strange trade.
 */
function bucketName() {
  const override = arg('bucket')
  if (override) return override
  const config = readFileSync(WRANGLER_PATH, 'utf8')
  const match = /"binding"\s*:\s*"AVATARS"\s*,\s*"bucket_name"\s*:\s*"([^"]+)"/.exec(config)
  if (!match) fail('could not find the AVATARS bucket_name in wrangler.jsonc — pass --bucket')
  return match[1]
}

const bucket = bucketName()

// ---------------------------------------------------------------------------
// wrangler
// ---------------------------------------------------------------------------

const target = local
  ? ['--local', '--persist-to', resolve(root, '.wrangler/state')]
  : ['--remote']

function run(args) {
  return new Promise((done) => {
    const child = spawn('npx', ['wrangler', ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.stdout.on('data', () => {})
    child.on('close', (code) => done({ code, stderr }))
  })
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms))

/** Retried, because both stores drop the occasional call and the operation is idempotent:
 *  the same bytes under the same key, in a prefix that never holds anything else. */
async function wrangler(args) {
  let last = { code: 1, stderr: '' }
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    last = await run(args)
    if (last.code === 0) return last
    if (attempt < ATTEMPTS) await wait(attempt * 400)
  }
  return last
}

// ---------------------------------------------------------------------------
// --delete <version>: drop a superseded generation
// ---------------------------------------------------------------------------

async function deleteGeneration(version) {
  const keys = catalog.exercises.flatMap((exercise) =>
    exercise.poses.map((pose) => `exercises/${version}/${exercise.id}/${pose}.webp`),
  )
  console.log(`exercises:populate — deleting ${keys.length} objects under exercises/${version}/`)
  let gone = 0
  await pool(keys, async (key) => {
    const { code } = await wrangler(['r2', 'object', 'delete', `${bucket}/${key}`, ...target])
    if (code === 0) gone += 1
  })
  // Best effort by design: an id that existed only in the *old* catalogue is not in this
  // list and leaves a few KB behind. R2's free tier is 10 GB; engineering that away would
  // mean keeping a manifest of every generation ever uploaded.
  console.log(`  deleted ${gone} of ${keys.length} (ids dropped since that generation may linger)`)
}

// ---------------------------------------------------------------------------
// The source snapshot
// ---------------------------------------------------------------------------

let scratch = null

/** Returns the directory holding `exercises.json` and `images/flat/`. */
async function sourceDir() {
  const dir = arg('dir')
  if (dir) return resolve(process.cwd(), dir)

  scratch = mkdtempSync(join(tmpdir(), 'repdb-'))
  let tarball = arg('tarball')
  if (tarball) {
    tarball = resolve(process.cwd(), tarball)
  } else {
    console.log(`exercises:populate — downloading ${TARBALL_URL}`)
    const response = await fetch(TARBALL_URL)
    if (!response.ok) fail(`${TARBALL_URL} answered ${response.status}`)
    tarball = join(scratch, 'repdb.tar.gz')
    writeFileSync(tarball, Buffer.from(await response.arrayBuffer()))
  }

  // `tar` rather than a dependency: this script already shells out to wrangler, and every
  // machine that can run `pnpm` has one.
  const { code, stderr } = await new Promise((done) => {
    const child = spawn('tar', ['-xzf', tarball, '-C', scratch, '--strip-components=1'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let err = ''
    child.stderr.on('data', (chunk) => (err += chunk))
    child.on('close', (exit) => done({ code: exit, stderr: err }))
  })
  if (code !== 0) fail(`tar failed: ${stderr.trim()}`)
  return scratch
}

// ---------------------------------------------------------------------------
// The ledger — resumability without a round trip per object
// ---------------------------------------------------------------------------

/**
 * Wrangler has `get`, `put` and `delete` and no `head`, so "is this key already there"
 * costs a full download of the object it would have saved uploading — the same bytes, the
 * same process start, no saving at all. So progress is recorded locally instead, one key
 * per line, and a re-run picks up where it stopped. `--force` ignores it.
 *
 * Uploading a key twice is harmless anyway: same key, same bytes, and the version in the
 * prefix means the bytes under a key can never differ from the ones already there. The
 * ledger is about not spending forty minutes again, not about correctness.
 */
const ledgerPath = resolve(root, `.wrangler/exercises-populate-${catalog.version}.${local ? 'local' : 'remote'}.txt`)
const ledger = new Set(
  !force && existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean) : [],
)
const ledgerAppend = (key) => {
  ledger.add(key)
  mkdirSync(dirname(ledgerPath), { recursive: true })
  writeFileSync(ledgerPath, `${[...ledger].join('\n')}\n`)
}

// ---------------------------------------------------------------------------

/** A fixed-size worker pool. `Promise.all` over 1,020 wrangler processes is a fork bomb. */
async function pool(items, work) {
  const width = local ? CONCURRENCY.local : CONCURRENCY.remote
  const queue = [...items]
  const workers = Array.from({ length: Math.min(width, queue.length) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) await work(next)
  })
  await Promise.all(workers)
}

const isWebp = (bytes) =>
  bytes.byteLength > 12 &&
  bytes.toString('latin1', 0, 4) === 'RIFF' &&
  bytes.toString('latin1', 8, 12) === 'WEBP'

async function main() {
  const remove = arg('delete')
  if (remove) {
    await deleteGeneration(remove)
    return
  }

  const dir = await sourceDir()
  const sourcePath = join(dir, 'exercises.json')
  if (!existsSync(sourcePath)) fail(`${dir} does not look like the RepDB repository (no exercises.json)`)

  const sourceBytes = readFileSync(sourcePath)
  const sha = createHash('sha256').update(sourceBytes).digest('hex')
  if (sha !== catalog.sourceSha256) {
    fail(
      `this snapshot is sha256 ${sha.slice(0, 12)}… but catalog.json was built from ${String(
        catalog.sourceSha256,
      ).slice(0, 12)}… — images and metadata must be one release. Re-run \`pnpm exercises:prune\` first.`,
    )
  }

  /**
   * The source path for each id+pose comes from the snapshot's *own* `images.flat`, not
   * from `<id>-<pose>.webp` guessed by hand — which is what makes the twelve alias pairs
   * (two exercises, one file) resolve correctly instead of 404ing on half of them.
   */
  const source = JSON.parse(sourceBytes.toString('utf8'))
  const flatById = new Map(source.exercises.map((exercise) => [exercise.id, exercise.images?.flat ?? {}]))

  const uploads = []
  for (const exercise of catalog.exercises) {
    const flat = flatById.get(exercise.id)
    if (!flat) fail(`${exercise.id} is in catalog.json but not in this snapshot`)
    for (const pose of exercise.poses) {
      const relative = flat[pose]
      if (!relative) fail(`${exercise.id}: the snapshot has no "${pose}" image`)
      uploads.push({
        key: `exercises/${catalog.version}/${exercise.id}/${pose}.webp`,
        file: join(dir, relative),
      })
    }
  }

  const pending = uploads.filter((upload) => !ledger.has(upload.key))
  console.log(`exercises:populate — bucket ${bucket} (${local ? 'local' : 'remote'})`)
  console.log(`  catalogue     ${catalog.count} exercises, version ${catalog.version}`)
  console.log(`  objects       ${uploads.length} (${uploads.length - pending.length} already done)`)
  if (dryRun) {
    console.log('  --dry-run: nothing uploaded')
    return
  }

  let done = 0
  let failed = 0
  await pool(pending, async ({ key, file }) => {
    const bytes = readFileSync(file)
    // The one check on the bytes, and the only thing this script is permitted to know
    // about them: that they are the WebP the catalogue says they are.
    if (!isWebp(bytes)) {
      console.error(`  ! ${key}: ${file} is not a WebP`)
      failed += 1
      return
    }
    const { code, stderr } = await wrangler([
      'r2',
      'object',
      'put',
      `${bucket}/${key}`,
      '--file',
      file,
      '--content-type',
      'image/webp',
      ...target,
    ])
    if (code !== 0) {
      console.error(`  ! ${key}: wrangler exited ${code} ${stderr.trim().split('\n').pop() ?? ''}`)
      failed += 1
      return
    }
    ledgerAppend(key)
    done += 1
    if (done % 50 === 0) console.log(`  ${done}/${pending.length}`)
  })

  console.log(`exercises:populate — uploaded ${done}, failed ${failed}`)
  if (failed) {
    console.error('  re-run to retry the failures; completed keys are recorded and skipped')
    process.exitCode = 1
  }
}

try {
  await main()
} finally {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
}
