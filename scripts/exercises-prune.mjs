#!/usr/bin/env node
/**
 * Vendors the RepDB exercise catalogue into `src/lib/exercises/catalog.json`.
 *
 * The catalogue is a **frozen, versioned, read-only third-party record** — the same
 * category as `docs/personal/data/*.csv` behind `src/lib/baseline.ts`, and the reason it
 * is not a D1 table. A table would be a second copy of a finished record with a sync
 * problem attached: nothing in this app ever writes an exercise, and every athlete reads
 * exactly the same 571 rows. Vendoring it makes the catalogue a build artifact that the
 * Worker, the prerender pass and vitest all read the same way (AGENTS gotcha 14), and
 * makes "which catalogue is this deployment running" a question with one answer.
 *
 * ## What is dropped, and why
 *
 * Source is 2,100,279 B of trilingual prose. Two cuts get it to ~650 KB:
 *
 *   - **Language.** The app speaks Spanish; `name_es`/`description_es`/`instructions_es`/
 *     `tips_es` ship and the `_en`/`_de` halves do not. That alone is ~69% of the bytes.
 *     `name_en` is the one exception: the MCP server offers `search_exercises` to agents,
 *     and agents query in English ("side plank"). ~14 KB for a searchable index.
 *   - **Rows.** `category ∈ {cardio, olympic}` goes — 30 of 601. The cardio in this app
 *     *is* running, so a treadmill row in a strength picker is search noise; olympic lifts
 *     are a skill discipline nobody on this deployment trains and a genuine injury vector
 *     to hand out as filler. Machines stay: leg curl, leg extension and hip ab/adduction
 *     are exactly what a physio hands a runner in knee rehab, which is what this feature
 *     is for.
 *
 * Columns dropped: `met`, `goals`, `force_type`, `mechanic`, `variation_group` (no
 * consumer), `is_bodyweight` (`equipment` absent is a perfect biconditional — verified 179
 * rows both ways, 0 either way — so it is derived rather than stored twice) and the raw
 * image paths (the app keys images by exercise id + pose, never by source path; twelve
 * files are shared between variation aliases and would make a path a false identity).
 *
 * ## Licence — RepDB Free Tier v1.0, `src/lib/exercises/LICENSE.md`
 *
 * Term 1 permits commercial in-app use; term 2 requires visible attribution, which is why
 * `README.md`, `/plantillas` and the exercise picker all carry "Exercise data by RepDB
 * (repdb.co)"; term 3 forbids redistributing the dataset *as a dataset*, which is why this
 * is a pruned in-app subset and why `GET /api/exercises` is a capped, trimmed, authed
 * search box rather than a dump. Term 5 forbids generative-AI derivation of the images in
 * any form — see `exercises-populate.mjs`, which copies bytes and nothing else.
 *
 * ## Usage
 *
 *   pnpm exercises:prune                   # fetch the CDN copy
 *   pnpm exercises:prune -- --file a.json  # an already-downloaded snapshot
 *
 * Refresh runbook: prune → review the diff → `pnpm test` → `pnpm exercises:populate` →
 * commit → deploy. **Populate before deploy**, or the new Worker compiles in a version
 * whose generation is not in R2 yet and serves 404s for its images until it lands.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE_URL = 'https://exercise-dataset.com/exercises.json'

/** Bumping this is RepDB's way of saying the shape changed. Guessing at a new one is how
 *  a silently-wrong catalogue ships, so we stop instead. */
const SCHEMA_VERSION = 3

/** The cut. See the header: the cardio in this app is running, and olympic lifting is not
 *  a thing anyone on this deployment trains. */
const DROP_CATEGORIES = new Set(['cardio', 'olympic'])

/** A truncated download still parses. 400 is comfortably under the 571 the cut yields and
 *  comfortably over anything a partial file would produce. */
const MIN_ROWS = 400

/** The two shapes `images.flat` is documented to take, and the only two that exist. */
const POSE_SETS = [
  ['start', 'peak'],
  ['main'],
]

/** Poses are stored in the order they are performed, not alphabetically — a detail sheet
 *  showing both frames shows the start before the peak. */
const POSE_ORDER = ['start', 'peak', 'main']

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CATALOG_PATH = resolve(root, 'src/lib/exercises/catalog.json')
const META_PATH = resolve(root, 'src/lib/exercise-meta.ts')

const fail = (message) => {
  console.error(`exercises:prune — ${message}`)
  process.exit(1)
}

const arg = (name) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? null : process.argv[at + 1]
}

async function readSource() {
  const file = arg('file')
  if (file) {
    const bytes = readFileSync(resolve(process.cwd(), file))
    return { bytes, from: file }
  }
  const response = await fetch(SOURCE_URL)
  if (!response.ok) fail(`${SOURCE_URL} answered ${response.status}`)
  return { bytes: Buffer.from(await response.arrayBuffer()), from: SOURCE_URL }
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

const nonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0
const nonEmptyList = (value) => Array.isArray(value) && value.length > 0 && value.every(nonEmptyString)

/** The poses this exercise has an illustration for, in a fixed order so the file is stable. */
function posesOf(exercise) {
  const flat = exercise.images?.flat
  if (!flat || typeof flat !== 'object') return null
  const keys = Object.keys(flat).sort((a, b) => POSE_ORDER.indexOf(a) - POSE_ORDER.indexOf(b))
  const known = POSE_SETS.some((set) => set.length === keys.length && set.every((k, i) => k === keys[i]))
  if (!known) return null
  return keys.every((key) => nonEmptyString(flat[key])) ? keys : null
}

/**
 * The projection. Explicit `null`s and `[]`s rather than absent keys: a uniform record is
 * a uniform TypeScript interface, and `equipment` being sometimes-absent is exactly the
 * kind of thing that reads as "optional" and behaves as "undefined at runtime".
 */
function project(exercise) {
  const poses = posesOf(exercise)
  if (!poses) fail(`${exercise.id}: images.flat is neither {start,peak} nor {main}`)
  for (const [field, ok] of [
    ['name_es', nonEmptyString(exercise.name_es)],
    ['name_en', nonEmptyString(exercise.name_en)],
    ['description_es', nonEmptyString(exercise.description_es)],
    ['instructions_es', nonEmptyList(exercise.instructions_es)],
    ['category', nonEmptyString(exercise.category)],
    ['body_part', nonEmptyString(exercise.body_part)],
    ['difficulty', nonEmptyString(exercise.difficulty)],
    ['primary_muscles', nonEmptyList(exercise.primary_muscles)],
  ]) {
    if (!ok) fail(`${exercise.id}: ${field} is missing or empty`)
  }
  // Verified biconditional on the live set: 179 rows carry both `is_bodyweight: true` and
  // no `equipment`, and no row carries one without the other. So the flag is derived
  // (`equipment === null`) rather than stored, and disagreement here means that stopped
  // being true and the derivation needs revisiting.
  const bodyweight = exercise.equipment == null
  if (Boolean(exercise.is_bodyweight) !== bodyweight) {
    fail(`${exercise.id}: is_bodyweight no longer equals "equipment is absent" — review catalog.ts`)
  }

  return {
    id: exercise.id,
    name: exercise.name_es,
    nameEn: exercise.name_en,
    description: exercise.description_es,
    instructions: exercise.instructions_es,
    tips: exercise.tips_es ?? [],
    category: exercise.category,
    bodyPart: exercise.body_part,
    difficulty: exercise.difficulty,
    equipment: exercise.equipment ?? null,
    primaryMuscles: exercise.primary_muscles,
    secondaryMuscles: exercise.secondary_muscles ?? [],
    tags: exercise.tags ?? [],
    isUnilateral: Boolean(exercise.is_unilateral),
    poses,
  }
}

const { bytes, from } = await readSource()
const sourceSha256 = sha256(bytes)

let source
try {
  source = JSON.parse(bytes.toString('utf8'))
} catch {
  fail(`${from} is not JSON`)
}

if (source.schema_version !== SCHEMA_VERSION) {
  fail(
    `schema_version is ${source.schema_version}, not ${SCHEMA_VERSION} — review the new schema before regenerating`,
  )
}
if (!Array.isArray(source.exercises)) fail('no `exercises` array')

const kept = source.exercises
  .filter((exercise) => !DROP_CATEGORIES.has(exercise.category))
  .map(project)
  // Sorted by id so a RepDB reorder cannot churn the committed diff.
  .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

if (kept.length < MIN_ROWS) fail(`only ${kept.length} rows after the cut — a truncated download?`)

const ids = new Set(kept.map((e) => e.id))
if (ids.size !== kept.length) fail('duplicate exercise ids')

/** Hashes the *shipped* projection, not the source: it is what keys the image URLs, so it
 *  must move when and only when the data the app serves moves. `sourceSha256` is the other
 *  half — `exercises-populate.mjs` uses it to prove the images come from this snapshot. */
const version = sha256(JSON.stringify(kept)).slice(0, 8)

const envelope = [
  '{',
  `"name": ${JSON.stringify(source.name)},`,
  '"homepage": "https://repdb.co",',
  '"license": "RepDB Free Tier v1.0 — attribution required, no redistribution as a dataset. See LICENSE.md.",',
  `"schemaVersion": ${SCHEMA_VERSION},`,
  `"sourceCount": ${source.exercises.length},`,
  `"count": ${kept.length},`,
  `"sourceSha256": ${JSON.stringify(sourceSha256)},`,
  `"version": ${JSON.stringify(version)},`,
  `"generated": ${JSON.stringify(new Date().toISOString().slice(0, 10))},`,
  '"exercises": [',
  // One record per line: 571 records on one line is a diff nobody can review, and pretty
  // printing them costs ~200 KB of indentation for the same information.
  kept.map((exercise) => JSON.stringify(exercise)).join(',\n'),
  ']}',
  '',
].join('\n')

mkdirSync(dirname(CATALOG_PATH), { recursive: true })
writeFileSync(CATALOG_PATH, envelope)

/**
 * The browser's half. `catalog.ts` is Worker-only by size (~650 KB), but the UI still has
 * to build an image URL — so the version and the URL shape are generated into their own
 * tiny module that anything may import.
 */
writeFileSync(
  META_PATH,
  `// Generated by scripts/exercises-prune.mjs — do not edit.
//
// The browser-safe half of the catalogue: the generation stamp and the URL shape, and
// nothing else. \`src/lib/exercises/\` is Worker-only (~650 KB of prose), so a component
// that wants a thumbnail imports this instead — the boundary is enforced by
// \`test/unit/exercises.test.ts\`, because tsc cannot see it.

/** The catalogue generation. Also the R2 prefix every mirrored image lives under, which is
 *  what makes the year-long immutable cache on those URLs honest: bytes under a successful
 *  URL never change, and a re-vendored catalogue moves every URL at once. */
export const CATALOG_VERSION = '${version}'

/** How many exercises this generation ships. */
export const CATALOG_COUNT = ${kept.length}

/**
 * The app URL for one illustration. \`card\` is the alias the UI uses when it does not know
 * which poses an exercise has — a session payload carries names and ids, never poses — and
 * the route resolves it server-side to \`peak\` where there is one and \`main\` otherwise.
 */
export const exerciseImageUrl = (
  exerciseId: string,
  pose: 'card' | 'start' | 'peak' | 'main' = 'card',
): string => \`/api/exercises/img/\${CATALOG_VERSION}/\${exerciseId}/\${pose}.webp\`
`,
)

const bytesOf = (path) => readFileSync(path).byteLength
console.log(`exercises:prune — source ${from}`)
console.log(`  sha256        ${sourceSha256}`)
console.log(`  rows          ${kept.length} of ${source.exercises.length} (dropped ${[...DROP_CATEGORIES].join(', ')})`)
console.log(`  version       ${version}`)
console.log(`  catalog.json  ${bytesOf(CATALOG_PATH).toLocaleString('en-US')} B`)
console.log(`  images        ${kept.reduce((n, e) => n + e.poses.length, 0)} R2 objects to populate`)
