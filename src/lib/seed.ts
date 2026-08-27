import { DAY_MS, DEFAULT_BLOCK, WEEK_MS, totalWeeks } from './block'
import type { NewPlanSession, NewPlanWeek } from './db/schema'
import { SESSION_META, type SessionType } from './plan'
import { PACES, type PaceBand, type PaceZone } from './paces'
import {
  cooldown,
  floatFor,
  forMinutes,
  effortMetres,
  hardDistanceM,
  jogFor,
  jogOver,
  km,
  reps,
  steady,
  strides,
  warmup,
  workoutBand,
  workoutDistanceM,
  type Step,
} from './workout'

/**
 * The block, written out. Source: docs/03-training-plan-2027.md.
 *
 * This is the *owner's* plan against `DEFAULT_BLOCK` and nothing else — 23 named weeks on
 * 23 real dates, with the Tast and the Behobia in the places the calendar puts them.
 * Every other athlete starts with an empty plan and writes their own — in `/plan`, or by
 * pointing an agent at their MCP endpoint, which builds the same shapes from
 * their own block; nothing here generalises, and it is not meant to.
 *
 * Deterministic and hand-authored — not an engine. Every quality session below is a
 * designed workout with its repetitions, rep pace and recovery spelled out as data, so
 * "5 × 1 km @ 3:50–3:58 with 90 s jog" is something the app can count, total and render
 * rather than a sentence in a notes field.
 *
 * Only the easy runs are computed: they absorb whatever the week's volume target has
 * left over once the designed sessions are paid for. That is the right way round — a
 * rep session is a fixed prescription and an easy run is a dial, so when the ramp moves
 * the workouts stay put and the easy days flex.
 *
 * Session ids are derived from week and weekday, so re-seeding after a tweak updates
 * rows in place. Any session edited by hand is overwritten — this is "reset to the
 * plan", not "merge with the plan".
 *
 * ## This file is the example block
 *
 * It is one athlete's twenty-three weeks, and it is the part of the repository a fork
 * *replaces* rather than configures. `config.ts` moves the race, the dates and the goal;
 * the paces below follow the goal on their own (`paces.ts`), and the phase shares and
 * volume ramp resolve against whatever length the block turns out to be. What cannot
 * follow is `WEEKS`: twenty-three hand-written skeletons, in Spanish, around one
 * athlete's four-run week, two dorsals on real dates and a knee protocol. A fork writes
 * its own — either by editing this file, which is the honest way to keep a plan in
 * version control, or by having an agent author one through the MCP server on
 * `POST /api/mcp`, which writes the same rows without going through `buildPlan` at all.
 * `slotsFor` below is what says so out loud when the two lengths disagree.
 */

/**
 * The block this file is the plan for, and the only one it is ever the plan for.
 *
 * `seed.ts` is the *owner's* hand-written block — 23 weeks of docs/03 typed out in
 * Spanish, naming el Tast and la Behobia. Every other athlete on this deployment starts
 * with an empty plan and writes their own, in `/plan` or by pointing an agent at their
 * MCP endpoint. So this reads `DEFAULT_BLOCK` rather than a signed-in athlete's: it is a
 * fixed document, not a generator, and `POST /api/plan/seed` is owner-only for that reason.
 */
const BLOCK = DEFAULT_BLOCK
const TOTAL_WEEKS = totalWeeks(BLOCK)

/**
 * The five phases, as *shares of the block* rather than as week numbers, with the volume
 * ramp endpoints. docs/03 §2.
 *
 * Week numbers were the obvious shape while there was one block; they are the wrong one
 * the moment the block's length comes out of `config.ts`, because a sixteen-week fork
 * would inherit a rebuild that runs to week 6 and a taper pinned to weeks 21–22 that it
 * never reaches. A share resolves against `TOTAL_WEEKS` and keeps the *proportions*,
 * which is what the phase structure actually claims: roughly a third rebuilding, a
 * quarter on base, a fifth at threshold, then race-specific and taper.
 *
 * The denominators are this block's own week counts — 7 + 6 + 5 + 3 + 2 = 23 — so at 23
 * weeks the resolution below reproduces exactly the boundaries docs/03 §2 was written
 * with (0–6, 7–12, 13–17, 18–20, 21–22). `test/unit/seed.test.ts` pins that.
 *
 * docs/03 was written for a 24 Aug start (22 weeks). The block actually began a week
 * earlier, on Mon 17 Aug, so it is 23 weeks — the extra week goes to rebuild, which is
 * both the phase already underway and the one where more patience is free.
 *
 * The endpoints are lower than docs/03 §2 because the week is four runs, not six: the
 * same kilometres over four days would put 17 km on the average run at the peak. What
 * the athlete loses in frequency comes back as length — a 13–17 km medium-long run on
 * Wednesday from the threshold phase on, and a long run that reaches 22 km. They are
 * kilometres, not shares: a ramp is a load an athlete can carry, and a load does not
 * scale with the calendar the way a proportion does.
 */
const PHASE_SHAPE = [
  { phase: 'reconstrucción', share: 7 / 23, startKm: 22, endKm: 36, focus: 'Todo suave, en llano y a sensaciones. Cuatro carreras, cadencia y fuerza de cadera desde el primer día.' },
  { phase: 'base', share: 6 / 23, startKm: 38, endKm: 50, focus: 'Una sesión de calidad por semana y la tirada larga creciendo. Dentro caben dos dorsales: el Tast y la Behobia.' },
  { phase: 'umbral', share: 5 / 23, startKm: 53, endKm: 62, focus: 'Dos sesiones de calidad por semana: series largas y tempo. La media larga del miércoles sostiene el volumen.' },
  { phase: 'específico', share: 3 / 23, startKm: 60, endKm: 48, focus: 'Todo a 3:47/km, con las piernas cansadas y cuesta abajo.' },
  { phase: 'puesta a punto', share: 2 / 23, startKm: 38, endKm: 28, focus: 'Menos volumen, más chispa.' },
] as const

export type Phase = (typeof PHASE_SHAPE)[number]['phase']

/** A phase with its span resolved onto a block of a given length. */
type PhaseSpan = (typeof PHASE_SHAPE)[number] & { from: number; to: number }

/**
 * The shares laid onto a block of `totalWeeks`, as spans of 0-based week indices.
 *
 * Rounding is applied to the *cumulative* share and not to each phase's own length,
 * because rounding five lengths independently loses or gains a week and the block has to
 * end on race week exactly. Cumulative rounding cannot drift: each boundary is computed
 * from the start of the block, so the errors do not accumulate, and the last phase is
 * pinned to the final week outright.
 *
 * Two clamps keep the result well-formed at lengths the shares were never drawn for. No
 * phase may reach past `totalWeeks - 1 - (phases still to come)`, which reserves a week
 * for each of them, and no phase may end before it begins — so every phase gets at least
 * one week, in order, with no gaps and no overlaps. A block shorter than the five phases
 * cannot hold them all: the leading ones are dropped, because what a compressed block
 * keeps is the end of it. `config.ts` will not accept fewer than four weeks in any case.
 *
 * Exported so the resolution can be tested at lengths this repository is not training
 * for — a proportion nobody has checked at 16 weeks is a proportion, not a guarantee.
 */
export function resolvePhases(totalWeeks: number): PhaseSpan[] {
  const shape = PHASE_SHAPE.slice(Math.max(0, PHASE_SHAPE.length - totalWeeks))
  const spans: PhaseSpan[] = []
  let from = 0
  let cumulative = 0

  shape.forEach((phase, i) => {
    cumulative += phase.share
    const stillToCome = shape.length - 1 - i
    const to =
      stillToCome === 0
        ? totalWeeks - 1
        : Math.min(
            Math.max(Math.round(cumulative * totalWeeks) - 1, from),
            totalWeeks - 1 - stillToCome,
          )
    spans.push({ ...phase, from, to })
    from = to + 1
  })

  return spans
}

const PHASES = resolvePhases(TOTAL_WEEKS)

/**
 * Cutback weeks. docs/03 §2 lists W4/8/12/16/20 against its own 22-week numbering; every
 * phase after rebuild shifted forward by one when the block gained a week at the front,
 * so W8 onward maps to the same index here and W4 lands in the fourth rebuild week.
 *
 * Two positions matter beyond the rhythm. Index 7 opens the base phase, and opening a new
 * phase on a cutback would waste the step up in volume that defines it. And the doc's
 * fourth cutback moved from index 16 to index 15 so that it lands on the December control
 * 10K: with four runs a week, a race week's two fixed sessions leave only two flexible
 * runs, and at 57 km those two would have to be 20 km each. A tune-up race belongs in a
 * cutback week anyway.
 *
 * These are week *indices*, not shares, and deliberately: a cutback lands on a specific
 * week for a specific reason — the phase it closes, the race it carries — and spreading
 * them proportionally would move them off both. They belong to the example block, like
 * `WEEKS` below, and a fork rewrites them with it. Indices past the end of a shorter
 * block are simply never asked about.
 */
const DOWN_WEEKS = new Set([3, 8, 12, 15, 20])
const DOWN_WEEK_FACTOR = 0.75

export const isDownWeek = (week: number) => DOWN_WEEKS.has(week)

function phaseOf(week: number) {
  const phase = PHASES.find((p) => week >= p.from && week <= p.to)
  if (!phase) throw new Error(`Week ${week} is outside the ${TOTAL_WEEKS}-week block`)
  return phase
}

export const phaseFor = (week: number): Phase => phaseOf(week).phase

/**
 * Hard ceiling on week-over-week growth. docs/02 is explicit that the binding constraints
 * are the knee and consistency, not fitness, and too-fast ramping is the classic way to
 * re-injure — so this wins over the headline phase targets where they disagree.
 */
const MAX_WEEKLY_GROWTH = 0.1

/** The uncut ramp: linear within each phase, before down weeks and the growth cap. */
function rawRampKm(week: number): number {
  const p = phaseOf(week)
  const span = p.to - p.from
  const progress = span === 0 ? 0 : (week - p.from) / span
  return p.startKm + (p.endKm - p.startKm) * progress
}

/**
 * The ramp with the growth cap applied, computed across the whole block rather than per
 * phase so the cap also holds at phase boundaries.
 *
 * The cap is applied *before* the down-week cut, so the rebound out of a down week returns
 * to the underlying ramp rather than being throttled to +10% of the reduced week.
 */
const CAPPED_RAMP_KM: readonly number[] = (() => {
  const capped: number[] = []
  for (let week = 0; week < TOTAL_WEEKS; week++) {
    const raw = rawRampKm(week)
    if (week === 0) {
      capped.push(raw)
      continue
    }
    // Only ascending steps are capped; taper and race-specific descend on purpose.
    capped.push(Math.min(raw, capped[week - 1]! * (1 + MAX_WEEKLY_GROWTH)))
  }
  return capped
})()

/** Weekly target volume in metres, after the growth cap and the down-week cut. */
export function weeklyVolumeM(week: number): number {
  if (week < 0 || week >= TOTAL_WEEKS) {
    throw new Error(`Week ${week} is outside the ${TOTAL_WEEKS}-week block`)
  }
  const km = CAPPED_RAMP_KM[week]!
  return Math.round(km * (isDownWeek(week) ? DOWN_WEEK_FACTOR : 1) * 1000)
}

// ---------------------------------------------------------------------------
// Session vocabulary
// ---------------------------------------------------------------------------

interface Slot {
  /** 0 = Monday. */
  day: number
  type: SessionType
  title: string
  notes?: string
  /** A designed workout. Its distance is the sum of its steps — nothing to distribute. */
  steps?: Step[]
  /** An easy run: takes this share of whatever the week's target has left over. */
  weight?: number
  /** Band for a weighted run. `null` is deliberate in Phase 0 — run easy by feel. */
  zone?: PaceZone | null
  /** Strides on the end of a weighted easy run. */
  stridesReps?: number
  /** Time-measured sessions — strength never carries a distance. */
  durationS?: number
  /** Overrides the pace band derived from the steps. Races carry their marker pace. */
  pace?: PaceBand
}

const CADENCE = 'Metrónomo a 170–176 pasos/min: la cadencia es a la vez el arreglo de la lesión y el marcador de forma en carrera.'
const FLAT = 'Terreno llano. Nada de carreteras peraltadas: alterna de lado o vete a la pista.'
const ONSET = 'Apunta el kilómetro en el que aparece la primera molestia: ese número tiene que subir cada semana.'

// docs/03 §6: strength twice weekly from week one, non-negotiable. Load the hip rather
// than stretch the band — the ITB is anchored to the femur and cannot be lengthened.
const STRENGTH_NOTES =
  'Planchas laterales con abducción de cadera · planchas Copenhague · caminatas laterales con goma · sentadillas a una pierna · peso muerto rumano a una pierna'

const MOBILITY_NOTES = `Solo movilidad y activación, nada pesado. ${STRENGTH_NOTES}`

/**
 * The week is five training days: four runs and one day that is nothing but strength.
 * Monday is that day — it consolidates Sunday's long run without putting another
 * kilometre on the knee, and it leaves Thursday genuinely empty.
 *
 * The second strength session is not a sixth day: it rides on Friday's run, so the two
 * sit four days apart without ever asking the athlete to leave the house again.
 */
const strength = (day: number, minutes = 35, notes = STRENGTH_NOTES): Slot => ({
  day,
  type: 'strength',
  title: 'Fuerza de cadera',
  notes,
  durationS: minutes * 60,
})

const rest = (day: number, notes = 'Descanso completo.'): Slot => ({ day, type: 'rest', title: 'Descanso', notes })

/**
 * Thursday. Empty on purpose, and the one slot the bike fits in — docs/03 §6 calls
 * cycling the pressure valve, and a valve prescribed every week stops being one.
 */
const THURSDAY = rest(
  3,
  'Descanso. Es el hueco donde entra la bici si la rodilla ha dicho algo esta semana: 45–60 min sueltos, sin impacto, sin atrancar.',
)

/** Saturday. Not a training day — the athlete's own rule, and the long run thanks it. */
const SATURDAY = rest(5, 'Sábado sin entrenar. Piernas frescas para la tirada del domingo.')

/** An easy run sized by the week, not by hand. */
const easy = (
  day: number,
  weight: number,
  opts: { zone?: PaceZone | null; strides?: number; title?: string; notes?: string } = {},
): Slot => ({
  day,
  type: 'easy',
  title: opts.title ?? (opts.strides ? 'Rodaje + progresiones' : 'Rodaje'),
  notes: opts.notes,
  weight,
  zone: opts.zone === undefined ? 'easy' : opts.zone,
  stridesReps: opts.strides,
})

/** A plain long run at a fixed distance. */
const long = (
  day: number,
  distanceKm: number,
  zone: PaceZone | null,
  notes?: string,
  title = 'Tirada larga',
): Slot => ({
  day,
  type: 'long',
  title,
  notes,
  steps: [steady(km(distanceKm), zone)],
})

const workout = (
  day: number,
  type: SessionType,
  title: string,
  steps: Step[],
  notes?: string,
): Slot => ({ day, type, title, steps, notes })

/** A race or time trial: warm up, run the distance, jog it off. */
const race = (
  day: number,
  title: string,
  distanceM: number,
  pace: PaceBand,
  notes: string,
  warmupKm = 3,
  cooldownKm = 2,
): Slot => ({
  day,
  type: 'race',
  title,
  notes,
  pace,
  steps: [
    warmup(km(warmupKm)),
    strides(4, 20, 'Despertar las piernas antes del disparo.'),
    steady(distanceM, null, 'A esfuerzo de competición.'),
    cooldown(km(cooldownKm)),
  ],
})

/** A checkpoint marker as a band, from docs/03 §5 — `36:15` over 10 km is 3:38/km. */
const marker = (secondsPerKm: number, spread = 3): PaceBand => ({
  lo: secondsPerKm - spread,
  hi: secondsPerKm + spread,
})

// ---------------------------------------------------------------------------
// The 23 weeks
//
// One skeleton, every week, so the week has a rhythm the athlete can plan a life
// around — and so a session that moves is visible as a departure rather than as noise:
//
//   Lun  fuerza de cadera, sin correr
//   Mar  calidad 1
//   Mié  rodaje · media larga entre semana a partir de la fase de umbral
//   Jue  libre (la bici, si hace falta)
//   Vie  calidad 2 + el segundo bloque de fuerza
//   Sáb  nada
//   Dom  tirada larga
//
// Four runs, two strength sessions, two empty days. Quality never lands on consecutive
// days (docs/03 §6: "never two hard days back-to-back"), and Saturday stays empty so the
// Sunday long run — the session that carries this plan — is never run on tired legs.
// The one Saturday with a number on it is the Tast, and that date is the athlete's,
// not the plan's.
// ---------------------------------------------------------------------------

const REBUILD_LONG = `Suave de principio a fin. ${FLAT} ${ONSET}`

const WEEKS: Slot[][] = [
  // ---- Phase 0 · Reconstrucción (W1–W7). All easy, flat, by feel. No pace bands: docs/03
  // §4, "In Phase 0, ignore all of these and run easy by feel."
  // W1 — 22 km. Four runs from the first week, and the fortnight that answers whether
  // slow hurts more than fast.
  [
    strength(0),
    easy(1, 1, { zone: null, notes: `${FLAT} ${CADENCE}` }),
    easy(2, 1, { zone: null, notes: 'Este, a propósito, más rápido que el del martes. docs/03 §6: hay que comprobar si duele más lento que rápido.' }),
    THURSDAY,
    easy(4, 0.8, { zone: null }),
    strength(4),
    SATURDAY,
    long(6, 8, null, REBUILD_LONG),
  ],
  // W2 — 24,2 km.
  [
    strength(0),
    easy(1, 1, { zone: null, notes: CADENCE }),
    easy(2, 1, { zone: null, notes: 'Otra vez a propósito más rápido. Con dos datos ya se responde la pregunta de lento contra rápido.' }),
    THURSDAY,
    easy(4, 0.8, { zone: null }),
    strength(4),
    SATURDAY,
    long(6, 9, null, REBUILD_LONG),
  ],
  // W3 — 26,6 km. Strides start (docs/03 §8: "Strides on flat ground from W3").
  [
    strength(0),
    easy(1, 1, { zone: null, notes: CADENCE }),
    easy(2, 1, { zone: null }),
    THURSDAY,
    easy(4, 0.8, { zone: null, strides: 6, notes: `${FLAT} Las progresiones son frecuencia suelta, no esprints.` }),
    strength(4),
    SATURDAY,
    long(6, 10, null, REBUILD_LONG),
  ],
  // W4 — 21,8 km, down. First cutback: absorb three weeks of running, do not add to them.
  [
    strength(0),
    easy(1, 1, { zone: null }),
    easy(2, 1, { zone: null }),
    THURSDAY,
    easy(4, 0.8, { zone: null, strides: 6 }),
    strength(4),
    SATURDAY,
    long(6, 8, null, REBUILD_LONG),
  ],
  // W5 — 31,3 km.
  [
    strength(0),
    easy(1, 1, { zone: null, notes: CADENCE }),
    easy(2, 1, { zone: null }),
    THURSDAY,
    easy(4, 0.8, { zone: null, strides: 6 }),
    strength(4),
    SATURDAY,
    long(6, 11, null, REBUILD_LONG),
  ],
  // W6 — 33,7 km.
  [
    strength(0),
    easy(1, 1, { zone: null }),
    easy(2, 1, { zone: null }),
    THURSDAY,
    easy(4, 0.8, { zone: null, strides: 6 }),
    strength(4),
    SATURDAY,
    long(6, 12, null, `${REBUILD_LONG} Cadencia 85+ todo el rato: este es el ensayo de la puerta.`),
  ],
  // W7 — 36 km. The Phase 0 gate: docs/03 §5, a 10K time trial around 40:30 with the
  // knee silent. Failing it is not failing the block — Phase 0 extends and Phase 1
  // compresses, and sub-1:20 survives that far better than a March relapse.
  [
    strength(0),
    easy(1, 1, { zone: null }),
    easy(2, 1, { zone: null }),
    THURSDAY,
    easy(4, 0.5, { zone: null, title: 'Soltar piernas', strides: 4 }),
    strength(4, 20, MOBILITY_NOTES),
    SATURDAY,
    race(
      6,
      '10K en solitario · puerta de la Fase 0',
      km(10),
      marker(243, 5),
      'Recorrido llano, solo o en grupo. ~40:30 con la rodilla callada pasa la puerta. Para a la primera señal de dolor lateral de rodilla: la puerta no vale nada al lado del bloque.',
    ),
  ],

  // ---- Phase 1 · Base (W8–W13). One quality session a week; volume carries the load.
  // Downhill thread opens here: short, shallow descents at the end of easy runs.
  // W8 — 38 km. Fartlek before structure: surges by feel are the gentlest way back in.
  [
    strength(0),
    workout(1, 'fartlek', 'Fartlek 8 × 1 min', [
      warmup(km(2.5)),
      reps(8, { durationS: 60 }, 'threshold', floatFor(60), 'Cambio de ritmo, no esprint. A sensaciones, no al reloj.'),
      cooldown(km(2.5)),
    ], 'Primera calidad del bloque. Si la rodilla dice algo, la sesión se acaba ahí.'),
    easy(2, 1, { notes: 'Acaba con 400 m de bajada suave. Primer descenso del bloque: controlado, cadencia rápida, sin frenar.' }),
    THURSDAY,
    easy(4, 0.8, { strides: 6 }),
    strength(4),
    SATURDAY,
    long(6, 14, 'long', 'Ya vale terreno rompepiernas; guarda la bajada de verdad para el final.'),
  ],
  // W9 — 30,3 km, down.
  [
    strength(0),
    workout(1, 'fartlek', 'Fartlek 6 × 2 min', [
      warmup(km(2)),
      reps(6, { durationS: 120 }, 'threshold', floatFor(90), 'Cambios más largos, mismo esfuerzo a sensaciones.'),
      cooldown(km(2)),
    ]),
    easy(2, 1),
    THURSDAY,
    easy(4, 0.6, { strides: 6 }),
    strength(4),
    SATURDAY,
    long(6, 12, 'long'),
  ],
  // W10 — 42,8 km. One quality only: the Tast is six days after Sunday's long run, and
  // this is the week that has to leave legs for it. The 17 km is the longest run before
  // the Behobia, and the reason a 20 km race two weeks later is a step and not a leap.
  [
    strength(0),
    workout(1, 'tempo', 'Series de umbral 3 × 8 min', [
      warmup(km(2.5)),
      reps(3, { durationS: 480 }, 'threshold', jogFor(90)),
      cooldown(km(2)),
    ], 'Cómodamente duro y repetible. Si la tercera serie es una pelea, el ritmo estaba mal.'),
    easy(2, 1),
    THURSDAY,
    easy(4, 0.6, { strides: 6 }),
    strength(4),
    SATURDAY,
    long(6, 17, 'long', 'Terreno rompepiernas. Las bajadas sueltas y rápidas, sin frenar. La más larga antes de la Behobia.'),
  ],
  // W11 — 45,2 km. **Tast de la Mitja, sábado 31 de octubre.** The one Saturday in the
  // block with a number on it, so Sunday is the rest day that week instead — four runs
  // either way. docs/03 §5 puts the sub-1:20 marker here at ~38:30.
  [
    strength(0),
    workout(1, 'tempo', 'Afilado 6 × 3 min', [
      warmup(km(3)),
      reps(6, { durationS: 180 }, 'threshold', jogFor(90), 'Corto y afilado: esto despierta, no cansa.'),
      cooldown(km(2.5)),
    ], 'Última sesión con ritmo antes del test. Si dudas entre pasarte y quedarte corto, quédate corto.'),
    easy(2, 1),
    THURSDAY,
    easy(4, 0.4, { title: 'Soltar piernas', strides: 4 }),
    strength(4, 20, MOBILITY_NOTES),
    race(
      5,
      'Tast de la Mitja · 10K',
      km(10),
      marker(231),
      'Día de test: el 10K que dice si el sub-1:20 sigue de pie. ~38:30 es el marcador de docs/03 §5. Se corre sobre el terreno de La Mitja, así que además es la primera lectura específica del recorrido. Los 2 primeros km, controlados: aquí se sale rápido y se paga tarde.',
    ),
    rest(6, 'Descanso. Ayer fue un test a tope; hoy no se corre. Si el cuerpo pide moverse, 30 min de bici muy suave y nada más.'),
  ],
  // W12 — 47,6 km. **Behobia–San Sebastián, domingo 8 de noviembre.** Twenty kilometres
  // with a dorsal on, run as the week's long run and nothing more — which is why it is a
  // `long` and not a `race`: nothing about this session is measured at race effort, and
  // typing it as a race would count all twenty kilometres as quality.
  //
  // Eight days after the Tast, so the week is a soft one: no quality at all, a medium-long
  // on Wednesday, and a shakeout on Friday.
  [
    strength(0),
    easy(1, 0.8, { title: 'Rodaje de recuperación', notes: 'Nueve días de dorsal a dorsal. Hoy se trota y ya está.' }),
    easy(2, 1.2, { title: 'Media larga entre semana', notes: 'La última tirada de verdad antes del domingo. Rompepiernas si puedes: la Behobia no es llana.' }),
    THURSDAY,
    easy(4, 0.5, { title: 'Soltar piernas', strides: 4 }),
    strength(4, 20, MOBILITY_NOTES),
    rest(5, 'Sábado sin entrenar. Día de viaje: piernas en alto y a beber.'),
    {
      day: 6,
      type: 'long',
      title: 'Behobia–San Sebastián · 20 km',
      notes:
        'Dorsal, pero no carrera: esto es una tirada larga más, a 4:45–5:10/km. Los primeros kilómetros bajan por el Bidasoa y treinta mil personas van a salir volando — déjalos ir. Gaintxurizketa (km 7) se sube a esfuerzo, nunca a ritmo. La bajada larga hacia Errenteria es el mejor ensayo de descenso de todo el bloque y a la vez el estímulo exacto que rompió la rodilla en enero: cadencia alta, zancada corta, sin frenar. Miracruz (km 16) se trota. Si la rodilla dice algo en la bajada, se acaba ahí y no pasa nada.',
      steps: [steady(km(20), 'long', '+192 m de desnivel: el ritmo lo pone el esfuerzo, no el reloj.')],
    },
  ],
  // W13 — 37,5 km, down. Two dorsals in nine days get absorbed here. Quality moves to
  // Friday so Tuesday can still be a jog: the legs are ten weeks in and two races deep.
  [
    strength(0),
    easy(1, 1, { title: 'Rodaje de recuperación' }),
    easy(2, 1),
    THURSDAY,
    workout(4, 'tempo', 'Tempo 2 × 10 min', [
      warmup(km(2)),
      reps(2, { durationS: 600 }, 'threshold', jogFor(120)),
      cooldown(km(2)),
    ], 'Reentrada al ritmo después de la Behobia. Controlado: la fase de umbral empieza la semana que viene.'),
    strength(4),
    SATURDAY,
    long(6, 13, 'long'),
  ],

  // ---- Phase 2 · Umbral (W14–W18). Two quality sessions a week, Tuesday and Friday,
  // and a Wednesday that stops being a filler run: from here it is 13–17 km, the second
  // longest of the week. Four days a week is what makes that necessary — the volume has
  // to live somewhere, and a medium-long run is the cheapest place to put it.
  // W14 — 53 km.
  [
    strength(0),
    workout(1, 'interval', '5 × 1 km', [
      warmup(km(3)),
      reps(5, { distanceM: km(1) }, 'vo2', jogFor(90)),
      cooldown(km(2)),
    ], 'Pista o un tramo llano medido. Mejor parciales iguales que una primera serie rápida.'),
    easy(2, 1, { title: 'Media larga entre semana', strides: 6 }),
    THURSDAY,
    workout(4, 'tempo', 'Tempo 20 min continuo', [
      warmup(km(2.5)),
      forMinutes(20, 'threshold', 'Sin cortes. Aquí la fase base rinde cuentas.'),
      cooldown(km(2)),
    ]),
    strength(4),
    SATURDAY,
    long(6, 17, 'long', 'Terreno rompepiernas de aquí en adelante. Acumula volumen de bajada suave.'),
  ],
  // W15 — 55,3 km.
  [
    strength(0),
    workout(1, 'interval', '3 × 2 km', [
      warmup(km(3)),
      reps(3, { distanceM: km(2) }, 'threshold', jogFor(120)),
      cooldown(km(2)),
    ], 'Series largas a umbral: el pan de cada día de esta fase.'),
    easy(2, 1, { title: 'Media larga entre semana' }),
    THURSDAY,
    workout(4, 'tempo', 'Tempo 2 × 12 min', [
      warmup(km(2.5)),
      reps(2, { durationS: 720 }, 'threshold', jogFor(120)),
      cooldown(km(2)),
    ]),
    strength(4),
    SATURDAY,
    long(6, 18, 'long', 'Rompepiernas. La más larga desde la Behobia.'),
  ],
  // W16 — 43,1 km, down. docs/03 §5 wants a 10K race in early December, ~37:00 — the only
  // honest read of fitness between the Tast and January, because the Behobia was run as a
  // tirada larga and says nothing about speed. It sits in a cutback week on purpose.
  [
    strength(0),
    workout(1, 'tempo', 'Afilado 6 × 3 min', [
      warmup(km(3)),
      reps(6, { durationS: 180 }, 'threshold', jogFor(90)),
      cooldown(km(2.5)),
    ], 'Despertar, no cansar. El domingo es el que cuenta.'),
    easy(2, 1.2, { title: 'Media larga entre semana' }),
    THURSDAY,
    easy(4, 0.5, { title: 'Soltar piernas', strides: 4 }),
    strength(4, 20, MOBILITY_NOTES),
    SATURDAY,
    race(
      6,
      '10K en competición · control',
      km(10),
      marker(222),
      'docs/03 §5: ~37:00 mantiene vivo el sub-1:20. Busca un 10K llano y rápido de principios de diciembre. Si no aparece ninguno, en solitario, pero con dorsal se corre más rápido.',
    ),
  ],
  // W17 — 59,8 km.
  [
    strength(0),
    workout(1, 'interval', '6 × 1 km', [
      warmup(km(3)),
      reps(6, { distanceM: km(1) }, 'vo2', jogFor(90)),
      cooldown(km(2)),
    ]),
    easy(2, 1, { title: 'Media larga entre semana' }),
    THURSDAY,
    workout(4, 'tempo', 'Tempo 3 × 10 min', [
      warmup(km(2.5)),
      reps(3, { durationS: 600 }, 'threshold', jogFor(120)),
      cooldown(km(2)),
    ]),
    strength(4),
    SATURDAY,
    long(6, 20, 'long', 'Veinte kilómetros, esta vez sin dorsal y sin excusas de perfil.'),
  ],
  // W18 — 62 km. Peak week. docs/03 §2: sustaining 55+ matters more than touching the
  // peak once — and on four runs a week, 62 km is what 68 was on six.
  [
    strength(0),
    workout(1, 'interval', '5 × 1,2 km', [
      warmup(km(3)),
      reps(5, { distanceM: km(1.2) }, 'vo2', jogFor(120)),
      cooldown(km(2)),
    ], 'La sesión más afilada del bloque. A partir de aquí todo es ritmo de carrera.'),
    easy(2, 1, { title: 'Media larga entre semana' }),
    THURSDAY,
    workout(4, 'tempo', 'Tempo 2 × 15 min', [
      warmup(km(2.5)),
      reps(2, { durationS: 900 }, 'threshold', jogFor(180)),
      cooldown(km(2)),
    ], 'Quince minutos seguidos a umbral, dos veces. La sesión que más se parece a la segunda mitad de una media.'),
    strength(4),
    SATURDAY,
    long(6, 22, 'long', 'La tirada más larga del bloque. Rompepiernas y sin prisa.'),
  ],

  // ---- Phase 3 · Específico (W19–W21). Everything at 3:47/km. docs/03 §7: run the
  // actual second half of La Mitja — 10 km of descent on tired legs is what broke the
  // knee in January and where 3:08 was gained.
  // W19 — 60 km.
  [
    strength(0),
    workout(1, 'interval', '6 × 1 km a ritmo de carrera', [
      warmup(km(3)),
      reps(6, { distanceM: km(1) }, 'race', jogFor(90), 'Aquí el ritmo objetivo debe ir controlado, no al límite.'),
      cooldown(km(2)),
    ]),
    easy(2, 1, { title: 'Media larga entre semana' }),
    THURSDAY,
    workout(4, 'tempo', 'Tempo 20 min continuo', [
      warmup(km(2.5)),
      forMinutes(20, 'threshold'),
      cooldown(km(2)),
    ], 'El último tempo puro del bloque. De aquí en adelante manda el 3:47.'),
    strength(4),
    SATURDAY,
    workout(6, 'long', 'Tirada larga · 3 × 3 km a ritmo de carrera', [
      steady(km(8), 'long'),
      reps(3, { distanceM: km(3) }, 'race', jogOver(km(1))),
      cooldown(km(2)),
    ], 'Específico del recorrido: hazla en la segunda mitad de La Mitja si puedes acercarte. Ritmo de carrera en bajada, con 8 km ya en las piernas.'),
  ],
  // W20 — 54 km. The session the whole phase exists for. Friday softens to a shakeout:
  // Sunday is the one that predicts the race, and it deserves legs.
  [
    strength(0),
    workout(1, 'interval', '4 × 2 km a ritmo de carrera', [
      warmup(km(3)),
      reps(4, { distanceM: km(2) }, 'race', jogFor(120)),
      cooldown(km(2)),
    ]),
    easy(2, 1, { title: 'Media larga entre semana' }),
    THURSDAY,
    easy(4, 0.5, { title: 'Soltar piernas', strides: 4 }),
    strength(4),
    SATURDAY,
    workout(6, 'long', 'Tirada larga · últimos 10 km a ritmo de carrera', [
      steady(km(11), 'long'),
      steady(km(10), 'race', 'Sin cortes a 3:47/km, en bajada y con las piernas cansadas. El ensayo general.'),
      cooldown(km(1)),
    ], 'La sesión que más predice de todo el bloque. Si aguanta esta, aguanta la carrera.'),
  ],
  // W21 — 36 km, down. docs/03 §5: the honest go/no-go. 36:15–36:30 → race for sub-1:20;
  // 37:30 → race for 1:21, which is still a large PB.
  [
    strength(0),
    workout(1, 'interval', '5 × 1 km a ritmo de carrera', [
      warmup(km(2.5)),
      reps(5, { distanceM: km(1) }, 'race', jogFor(90)),
      cooldown(km(1.5)),
    ]),
    easy(2, 1),
    THURSDAY,
    easy(4, 0.5, { title: 'Soltar piernas', strides: 4 }),
    strength(4, 20, MOBILITY_NOTES),
    SATURDAY,
    race(
      6,
      '10K · sí o no',
      km(10),
      marker(218),
      'docs/03 §5: 36:15–36:30 significa correr a por el sub-1:20. 37:30 significa correr a por 1:21. Se decide aquí, no en la línea de salida.',
    ),
  ],

  // ---- Phase 4 · Puesta a punto (W22–W23). Two weeks, against last block's four days.
  // W22 — 38 km.
  [
    strength(0),
    workout(1, 'interval', '5 × 1 km a ritmo de carrera', [
      warmup(km(2.5)),
      reps(5, { distanceM: km(1) }, 'race', jogFor(90), 'Piernas rápidas, no cansadas. Corta mientras siga pareciendo fácil.'),
      cooldown(km(1.5)),
    ]),
    easy(2, 1),
    THURSDAY,
    easy(4, 0.5, { strides: 6 }),
    strength(4, 20, MOBILITY_NOTES),
    SATURDAY,
    workout(6, 'long', 'Tirada larga · 5 km a ritmo de carrera', [
      steady(km(8), 'long'),
      steady(km(5), 'race'),
      cooldown(km(2)),
    ], 'Última tirada larga. El volumen baja; la chispa no.'),
  ],
  // W23 — race week. Every session fixed: the ramp says 28 km, but 21,1 of that is the
  // race itself, which would leave seven kilometres across six days — a shutdown, not a
  // taper. Fifteen kilometres of easy running before the gun is the honest version.
  [
    strength(0, 20, MOBILITY_NOTES),
    workout(1, 'tempo', 'Afinado 3 × 1 km a ritmo de carrera', [
      warmup(km(1.5)),
      reps(3, { distanceM: km(1) }, 'race', jogOver(400)),
      cooldown(km(1.1)),
    ], 'El último esfuerzo fuerte. Es un recordatorio, no un entrenamiento.'),
    workout(2, 'easy', 'Rodaje', [steady(km(5), 'easy')]),
    THURSDAY,
    workout(4, 'easy', 'Soltar piernas + progresiones', [steady(km(3.6), 'easy'), strides(4)], 'Las piernas girando, nada más. Es el último día con zapatillas antes del domingo.'),
    rest(5, 'Sábado sin entrenar, como todo el bloque. Si a media tarde las piernas piden movimiento, 15 min de trote muy suave y ya: es la única excepción que el cuerpo agradece.'),
    {
      day: 6,
      type: 'race',
      // The one session title that is not written out: it is the race in `config.ts`,
      // which is the name on the bib and on every screen that counts down to it.
      title: BLOCK.raceName,
      notes:
        'El sub-1:20 son 3:47/km. Los primeros 10 km suben +140 m: mantén la franja de ritmo y deja que la segunda mitad lo devuelva entre −1 y −1,8 %. Cadencia 85+ en la bajada — la misma que se ensayó en la Behobia.',
      pace: PACES.race,
      steps: [
        warmup(km(1.5)),
        strides(4, 20, 'Tres o cuatro, justo antes de la salida.'),
        steady(BLOCK.raceDistanceM, 'race', '21,1 km a ritmo objetivo.'),
      ],
    },
  ],
]
const WEEKDAY = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

/**
 * The week's skeleton, or a refusal.
 *
 * `WEEKS` is hand-written and this long, so it is the one thing in the file that cannot
 * stretch to a block of another length. A fifteen-week fork would silently be handed
 * this block's first fifteen weeks — all rebuild and base, no taper, no race, and a
 * ramp that stops climbing at 50 km — and a twenty-six-week one would read past the end.
 * The first is worse than the second, because it looks like a plan. So the length has to
 * match exactly, and the mismatch is said out loud at the point of use rather than left
 * to be noticed in week fifteen.
 */
function slotsFor(week: number): Slot[] {
  if (WEEKS.length !== TOTAL_WEEKS) {
    throw new Error(
      `The example block in seed.ts is ${WEEKS.length} weeks and this block is ` +
        `${TOTAL_WEEKS}, so seeding it would ` +
        `${WEEKS.length > TOTAL_WEEKS ? 'cut the plan off before its taper' : 'run past the last week written'}. ` +
        `Rewrite WEEKS for your own block, or author the plan through the MCP server on ` +
        `POST /api/mcp instead of seeding it.`,
    )
  }
  const slots = WEEKS[week]
  if (!slots) throw new Error(`Week ${week} is outside the ${TOTAL_WEEKS}-week block`)
  return slots
}

/** Round to the nearest 100 m — the precision a prescribed easy run deserves. */
const round100 = (metres: number) => Math.round(metres / 100) * 100

/**
 * Sizes the week's easy runs from what the designed sessions leave over, then hands the
 * rounding residue to the longest of them so the week sums to its target exactly.
 */
function sizeEasyRuns(slots: Slot[], volumeM: number): Map<Slot, number> {
  const weighted = slots.filter((s) => s.weight != null && s.weight > 0)
  const sizes = new Map<Slot, number>()
  if (weighted.length === 0) return sizes

  const fixedM = slots
    .filter((s) => s.steps && SESSION_META[s.type].countsAsVolume)
    .reduce((sum, s) => sum + workoutDistanceM(s.steps!), 0)

  const pool = Math.max(0, volumeM - fixedM)
  const totalWeight = weighted.reduce((sum, s) => sum + s.weight!, 0)

  let assigned = 0
  for (const slot of weighted) {
    const metres = round100((pool * slot.weight!) / totalWeight)
    sizes.set(slot, metres)
    assigned += metres
  }

  const longest = weighted.reduce((a, b) => (sizes.get(a)! >= sizes.get(b)! ? a : b))
  sizes.set(longest, sizes.get(longest)! + (pool - assigned))
  return sizes
}

/** The steps a slot actually ships with — designed, or built around its sized distance. */
function stepsFor(slot: Slot, sizes: Map<Slot, number>): Step[] | null {
  if (slot.steps) return slot.steps
  const metres = sizes.get(slot)
  if (metres == null || metres <= 0) return null

  const stride = slot.stridesReps ? strides(slot.stridesReps) : null
  // The strides are part of the distance, not on top of it — otherwise every week with
  // strides in it quietly overshoots its target.
  const strideM = stride ? workoutDistanceM([stride]) : 0
  const run = steady(metres - strideM, slot.zone ?? null)
  return stride ? [run, stride] : [run]
}

/**
 * A plan row before it is stamped with the athlete it belongs to.
 *
 * `userId` is the route's to add, not the plan's: the same 183 rows are the owner's plan
 * whoever is asked to insert them, and threading an id through 700 lines of prescription
 * would put a tenant in a file that is otherwise pure arithmetic on dates.
 *
 * `targetVolumeM` goes the other way — the column is nullable, so drizzle's insert type
 * makes it optional, but a week this file built always has one: it is the sum of what its
 * own sessions prescribe. Saying so here is what lets a caller add the weeks up.
 */
export type SeedWeek = Omit<NewPlanWeek, 'userId' | 'targetVolumeM'> & { targetVolumeM: number }
export type SeedSession = Omit<NewPlanSession, 'userId'>

export interface PlanSeed {
  weeks: SeedWeek[]
  sessions: SeedSession[]
}

/**
 * The whole plan, weeks and sessions together.
 *
 * A week's `targetVolumeM` is the sum of what its sessions actually prescribe, not the
 * ramp figure they were sized from. The two agree everywhere except race week, and where
 * they disagree the sessions are the truth — a target no session adds up to is a number
 * that quietly stops meaning anything.
 */
export function buildPlan(now: number): PlanSeed {
  const sessions: SeedSession[] = []
  const volumeByWeek = new Array<number>(TOTAL_WEEKS).fill(0)

  for (let week = 0; week < TOTAL_WEEKS; week++) {
    const slots = slotsFor(week)
    const weekStart = BLOCK.startsOn + week * WEEK_MS
    const sizes = sizeEasyRuns(slots, weeklyVolumeM(week))
    // dayOrder disambiguates a double day — the run comes before the strength session.
    const orderByDay = new Map<number, number>()

    for (const slot of slots) {
      const dayOrder = orderByDay.get(slot.day) ?? 0
      orderByDay.set(slot.day, dayOrder + 1)

      const steps = stepsFor(slot, sizes)
      const meta = SESSION_META[slot.type]
      const distanceM = steps && meta.countsAsVolume ? workoutDistanceM(steps) : null
      const band = slot.pace ?? (steps ? workoutBand(steps) : null)

      if (distanceM) volumeByWeek[week]! += distanceM

      sessions.push({
        id: `w${String(week).padStart(2, '0')}-${WEEKDAY[slot.day]}-${dayOrder}`,
        scheduledOn: weekStart + slot.day * DAY_MS,
        dayOrder,
        type: slot.type,
        title: slot.title,
        notes: slot.notes ?? null,
        steps,
        targetDistanceM: distanceM,
        targetDurationS: slot.durationS ?? null,
        targetPaceLoSKm: band?.lo ?? null,
        targetPaceHiSKm: band?.hi ?? null,
        doneAt: null,
        activityId: null,
        updatedAt: now,
      })
    }
  }

  const weeks: SeedWeek[] = Array.from({ length: TOTAL_WEEKS }, (_, week) => ({
    weekIndex: week,
    phase: phaseOf(week).phase,
    focus: phaseOf(week).focus,
    targetVolumeM: volumeByWeek[week]!,
    isDownWeek: isDownWeek(week),
    notes: null,
    updatedAt: now,
  }))

  return { weeks, sessions }
}

/**
 * Metres run at threshold or faster in a week, over the week's total.
 *
 * docs/03 §3 puts quality at 20–25% of kilometres. Warm-ups, cool-downs and recovery
 * jogs are not quality, which is why this measures the hard steps rather than the
 * distance of the sessions that contain them.
 */
export function hardShare(week: number): number {
  const slots = slotsFor(week)
  const sizes = sizeEasyRuns(slots, weeklyVolumeM(week))
  let hard = 0
  let total = 0
  for (const slot of slots) {
    const steps = stepsFor(slot, sizes)
    if (!steps || !SESSION_META[slot.type].countsAsVolume) continue
    // A race carries no pace zone — nobody races a band — but every metre of it is hard.
    hard +=
      slot.type === 'race'
        ? steps
            .filter((s) => s.kind === 'rep' || s.kind === 'steady')
            .reduce((sum, s) => sum + effortMetres(s), 0)
        : hardDistanceM(steps)
    total += workoutDistanceM(steps)
  }
  return total === 0 ? 0 : hard / total
}
