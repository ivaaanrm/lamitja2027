import { BLOCK_START, DAY_MS, HALF_MARATHON_M, TOTAL_WEEKS, WEEK_MS } from './block'
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
  primaryZone,
  reps,
  steady,
  strides,
  warmup,
  workoutDistanceM,
  type Step,
} from './workout'

/**
 * The block, written out. Source: docs/03-training-plan-2027.md.
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
 */

/** Phase spans by 0-based week index, with the volume ramp endpoints. docs/03 §2. */
const PHASES = [
  // docs/03 was written for a 24 Aug start (22 weeks). The block actually began a week
  // earlier, on Mon 17 Aug, so it is 23 weeks — the extra week goes to rebuild, which is
  // both the phase already underway and the one where more patience is free.
  { phase: 'reconstrucción', from: 0, to: 6, startKm: 22, endKm: 36, focus: 'Todo suave, en llano y a sensaciones. Cadencia y fuerza de cadera desde el primer día.' },
  { phase: 'base', from: 7, to: 12, startKm: 40, endKm: 52, focus: 'Una sesión de calidad por semana. Tirada larga de 14 a 18 km.' },
  { phase: 'umbral', from: 13, to: 17, startKm: 56, endKm: 68, focus: 'Dos sesiones de calidad por semana: series largas y tempo.' },
  { phase: 'específico', from: 18, to: 20, startKm: 66, endKm: 52, focus: 'Todo a 3:47/km, con las piernas cansadas y cuesta abajo.' },
  { phase: 'puesta a punto', from: 21, to: 22, startKm: 40, endKm: 28, focus: 'Menos volumen, más chispa.' },
] as const

export type Phase = (typeof PHASES)[number]['phase']

/**
 * Cutback weeks. docs/03 §2 lists W4/8/12/16/20 against its own 22-week numbering; every
 * phase after rebuild shifted forward by one when the block gained a week at the front,
 * so W8 onward maps to the same index here and W4 lands in the fourth rebuild week.
 *
 * Keeping the doc's positions rather than "every fourth week" matters at one place in
 * particular: index 7 opens the base phase, and opening a new phase on a cutback would
 * waste the step up in volume that defines it.
 */
const DOWN_WEEKS = new Set([3, 8, 12, 16, 20])
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
 *
 * They do disagree in two places: docs/03's rebuild phase (22 → 36 km over six weeks)
 * implies 10.3%/wk, and the rebuild→base handover implies 11%. Both are capped here.
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
  /** Time-measured sessions — strength and cycling never carry a distance. */
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

const strength = (day: number, minutes = 30, notes = STRENGTH_NOTES): Slot => ({
  day,
  type: 'strength',
  title: 'Fuerza de cadera',
  notes,
  durationS: minutes * 60,
})

const bike = (day: number, minutes: number, notes?: string): Slot => ({
  day,
  type: 'cross',
  title: 'Bici',
  notes: notes ?? 'Carga aeróbica sin impacto. Pedalea suelto, no atranques. El sustituto automático cualquier día con molestias.',
  durationS: minutes * 60,
})

const rest = (day: number, notes = 'Descanso completo.'): Slot => ({ day, type: 'rest', title: 'Descanso', notes })

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
const long = (day: number, distanceKm: number, zone: PaceZone | null, notes?: string): Slot => ({
  day,
  type: 'long',
  title: 'Tirada larga',
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
// Layout is stable so the week has a rhythm: Monday is strength and no running,
// Tuesday is the hard day, the weekend carries the long run. Nothing quality ever
// lands on consecutive days (docs/03 §6: "never two hard days back-to-back").
// ---------------------------------------------------------------------------

const REBUILD_LONG = `Suave de principio a fin. ${FLAT} ${ONSET}`

const WEEKS: Slot[][] = [
  // ---- Phase 0 · Rebuild (W1–W7). All easy, flat, by feel. No pace bands: docs/03 §4,
  // "In Phase 0, ignore all of these and run easy by feel."
  // W1 — 22 km. Four runs, and the fortnight that answers whether slow hurts more than fast.
  [
    strength(0),
    easy(1, 1, { zone: null, notes: `${FLAT} ${CADENCE}` }),
    easy(2, 1, { zone: null, notes: 'Este a propósito más rápido que el del martes. docs/03 §6: comprobar si duele más lento que rápido.' }),
    bike(3, 45),
    easy(4, 1, { zone: null }),
    strength(4),
    rest(5),
    long(6, 8, null, REBUILD_LONG),
  ],
  // W2 — 24 km.
  [
    strength(0),
    easy(1, 1, { zone: null, notes: CADENCE }),
    easy(2, 1, { zone: null, notes: 'Otra vez a propósito más rápido. Con dos datos ya se responde la pregunta de lento contra rápido.' }),
    bike(3, 45),
    easy(4, 1, { zone: null }),
    strength(4),
    rest(5),
    long(6, 9, null, REBUILD_LONG),
  ],
  // W3 — 27 km. Strides start (docs/03 §8: "Strides on flat ground from W3").
  [
    strength(0),
    easy(1, 1, { zone: null, notes: CADENCE }),
    easy(2, 1, { zone: null }),
    bike(3, 45),
    easy(4, 1, { zone: null, strides: 6, notes: `${FLAT} Las progresiones son frecuencia suelta, no esprints.` }),
    strength(4),
    rest(5),
    long(6, 10, null, REBUILD_LONG),
  ],
  // W4 — 22 km, down. First cutback: absorb three weeks of running, do not add to them.
  [
    strength(0),
    easy(1, 1, { zone: null }),
    easy(2, 1, { zone: null }),
    bike(3, 45),
    easy(4, 1, { zone: null, strides: 6 }),
    strength(4),
    rest(5),
    long(6, 8, null, REBUILD_LONG),
  ],
  // W5 — 31 km. Fifth run a week from here.
  [
    strength(0),
    easy(1, 1, { zone: null, notes: CADENCE }),
    easy(2, 1, { zone: null }),
    bike(3, 60),
    easy(4, 1, { zone: null, strides: 6 }),
    strength(4),
    easy(5, 1, { zone: null }),
    long(6, 11, null, REBUILD_LONG),
  ],
  // W6 — 34 km.
  [
    strength(0),
    easy(1, 1, { zone: null }),
    easy(2, 1, { zone: null }),
    bike(3, 60),
    easy(4, 1, { zone: null, strides: 6 }),
    strength(4),
    easy(5, 1, { zone: null }),
    long(6, 12, null, `${REBUILD_LONG} Cadencia 85+ todo el rato: este es el ensayo de la puerta.`),
  ],
  // W7 — 36 km. The Phase 0 gate: docs/03 §5, a 10K time trial around 40:30 with the
  // knee silent. Failing it is not failing the block — Phase 0 extends and Phase 1
  // compresses, and sub-1:20 survives that far better than a March relapse.
  [
    strength(0),
    easy(1, 1, { zone: null }),
    easy(2, 1, { zone: null }),
    bike(3, 45),
    easy(4, 1, { zone: null, strides: 6 }),
    strength(4),
    easy(5, 0.4, { zone: null, title: 'Soltar piernas' }),
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
  // W8 — 40 km. Fartlek before structure: surges by feel are the gentlest way back in.
  [
    strength(0),
    workout(1, 'fartlek', 'Fartlek 8 × 1 min', [
      warmup(km(2)),
      reps(8, { durationS: 60 }, 'threshold', floatFor(60), 'Cambio de ritmo, no esprint. A sensaciones, no al reloj.'),
      cooldown(km(2)),
    ], 'Primera calidad del bloque. Si la rodilla dice algo, la sesión se acaba ahí.'),
    easy(2, 1),
    easy(3, 1, { notes: 'Acaba con 400 m de bajada suave. Primer descenso del bloque: controlado, cadencia rápida, sin frenar.' }),
    easy(4, 1, { strides: 6 }),
    strength(4),
    rest(5),
    long(6, 14, 'long', 'Ya vale terreno rompepiernas; guarda la bajada de verdad para el final.'),
  ],
  // W9 — 32 km, down.
  [
    strength(0),
    workout(1, 'fartlek', 'Fartlek 6 × 2 min', [
      warmup(km(2)),
      reps(6, { durationS: 120 }, 'threshold', floatFor(90), 'Cambios más largos, mismo esfuerzo a sensaciones.'),
      cooldown(km(1.5)),
    ]),
    easy(2, 1),
    easy(3, 1),
    easy(4, 1, { strides: 6 }),
    strength(4),
    rest(5),
    long(6, 12, 'long'),
  ],
  // W10 — 45 km. docs/03 §5: El Tast 10K on its usual late-October date, ~38:30.
  [
    strength(0),
    easy(1, 1, { strides: 6 }),
    easy(2, 1),
    easy(3, 1.6, { title: 'Media larga entre semana', notes: 'Esta semana la tirada larga es la carrera; esta cubre la resistencia.' }),
    easy(4, 0.5, { title: 'Soltar piernas', strides: 4 }),
    strength(4, 20, `Solo movilidad a dos días. ${STRENGTH_NOTES}`),
    rest(5),
    race(
      6,
      'El Tast 10K',
      km(10),
      marker(231),
      'docs/03 §5: ~38:30 es el marcador de sub-1:20 aquí. Confirma la fecha de 2027 — la edición de 2025 fue el 25 de octubre. Si no se celebra, hazlo en solitario.',
    ),
  ],
  // W11 — 47 km. Structure arrives: cruise intervals rather than a continuous tempo, so
  // the first threshold work of the block comes in swallowable pieces.
  [
    strength(0),
    workout(1, 'tempo', 'Series de umbral 3 × 8 min', [
      warmup(km(2.5)),
      reps(3, { durationS: 480 }, 'threshold', jogFor(90)),
      cooldown(km(2)),
    ], 'Cómodamente duro y repetible. Si la tercera serie es una pelea, el ritmo estaba mal.'),
    easy(2, 1),
    easy(3, 1),
    easy(4, 1, { strides: 6 }),
    strength(4),
    rest(5),
    long(6, 17, 'long', 'Terreno rompepiernas. Las bajadas sueltas y rápidas, sin frenar.'),
  ],
  // W12 — 50 km.
  [
    strength(0),
    workout(1, 'tempo', 'Series de umbral 2 × 12 min', [
      warmup(km(2.5)),
      reps(2, { durationS: 720 }, 'threshold', jogFor(120)),
      cooldown(km(2)),
    ]),
    easy(2, 1),
    easy(3, 1),
    easy(4, 1, { strides: 6 }),
    strength(4),
    rest(5),
    long(6, 18, 'long', 'La más larga de la fase base. Rompepiernas, con los últimos 2 km en bajada suave.'),
  ],
  // W13 — 39 km, down. One continuous tempo to close the phase — the pieces joined up.
  [
    strength(0),
    workout(1, 'tempo', 'Tempo 20 min continuo', [
      warmup(km(2.5)),
      forMinutes(20, 'threshold', 'Sin cortes. Aquí la fase base rinde cuentas.'),
      cooldown(km(2)),
    ]),
    easy(2, 1),
    easy(3, 1),
    easy(4, 1, { strides: 6 }),
    strength(4),
    rest(5),
    long(6, 15, 'long'),
  ],

  // ---- Phase 2 · Threshold (W14–W18). Two quality sessions a week: long reps and tempo,
  // never on consecutive days. Long runs move onto rolling terrain (docs/03 §7).
  // W14 — 56 km.
  [
    strength(0),
    workout(1, 'interval', '5 × 1 km', [
      warmup(km(3)),
      reps(5, { distanceM: km(1) }, 'vo2', jogFor(90)),
      cooldown(km(2)),
    ], 'Pista o un tramo llano medido. Mejor parciales iguales que una primera serie rápida.'),
    easy(2, 1),
    easy(3, 1),
    workout(4, 'tempo', 'Tempo 20 min', [
      warmup(km(2.5)),
      forMinutes(20, 'threshold'),
      cooldown(km(2)),
    ]),
    strength(4),
    easy(5, 1),
    long(6, 18, 'long', 'Terreno rompepiernas de aquí en adelante. Acumula volumen de bajada suave.'),
  ],
  // W15 — 59 km.
  [
    strength(0),
    workout(1, 'interval', '4 × 2 km', [
      warmup(km(3)),
      reps(4, { distanceM: km(2) }, 'threshold', jogFor(120)),
      cooldown(km(2)),
    ], 'Series largas a umbral: el pan de cada día de esta fase.'),
    easy(2, 1),
    easy(3, 1),
    workout(4, 'tempo', 'Tempo 2 × 10 min', [
      warmup(km(2.5)),
      reps(2, { durationS: 600 }, 'threshold', jogFor(120)),
      cooldown(km(2)),
    ]),
    strength(4),
    easy(5, 1),
    long(6, 20, 'long', 'Rompepiernas. Los primeros 20 km del bloque.'),
  ],
  // W16 — 62 km. docs/03 §5: a 10K race in early December, ~37:00.
  [
    strength(0),
    workout(1, 'interval', '6 × 1 km', [
      warmup(km(3)),
      reps(6, { distanceM: km(1) }, 'vo2', jogFor(90)),
      cooldown(km(2)),
    ]),
    easy(2, 1),
    easy(3, 1.4, { title: 'Media larga entre semana' }),
    easy(4, 0.7),
    strength(4, 20, `Solo movilidad, a dos días. ${STRENGTH_NOTES}`),
    easy(5, 0.4, { title: 'Soltar piernas', strides: 4 }),
    race(
      6,
      '10K en competición · control',
      km(10),
      marker(222),
      'docs/03 §5: ~37:00 mantiene vivo el sub-1:20. Busca un 10K llano y rápido en diciembre.',
    ),
  ],
  // W17 — 49 km, down. Cutback straight after the race, straight before the peak.
  [
    strength(0),
    workout(1, 'interval', '3 × 2 km', [
      warmup(km(2.5)),
      reps(3, { distanceM: km(2) }, 'threshold', jogFor(120)),
      cooldown(km(2)),
    ]),
    easy(2, 1),
    easy(3, 1),
    workout(4, 'tempo', 'Tempo 15 min', [
      warmup(km(2.5)),
      forMinutes(15, 'threshold'),
      cooldown(km(1.5)),
    ]),
    strength(4),
    easy(5, 1),
    long(6, 16, 'long'),
  ],
  // W18 — 68 km. Peak week. docs/03 §2: sustaining 55+ matters more than touching 68 once.
  [
    strength(0),
    workout(1, 'interval', '5 × 1,2 km', [
      warmup(km(3)),
      reps(5, { distanceM: km(1.2) }, 'vo2', jogFor(120)),
      cooldown(km(2)),
    ], 'La sesión más afilada del bloque. A partir de aquí todo es ritmo de carrera.'),
    easy(2, 1),
    easy(3, 1),
    workout(4, 'tempo', 'Tempo 3 × 10 min', [
      warmup(km(2.5)),
      reps(3, { durationS: 600 }, 'threshold', jogFor(120)),
      cooldown(km(2)),
    ]),
    strength(4),
    easy(5, 1),
    long(6, 22, 'long', 'La tirada más larga del bloque. Rompepiernas y sin prisa.'),
  ],

  // ---- Phase 3 · Race-specific (W19–W21). Everything at 3:47/km. docs/03 §7: run the
  // actual second half of La Mitja — 10 km of descent on tired legs is what broke the
  // knee in January and where 3:08 was gained.
  // W19 — 66 km.
  [
    strength(0),
    workout(1, 'interval', '6 × 1 km a ritmo de carrera', [
      warmup(km(3)),
      reps(6, { distanceM: km(1) }, 'race', jogFor(90), 'Aquí el ritmo objetivo debe ir controlado, no al límite.'),
      cooldown(km(2)),
    ]),
    easy(2, 1),
    easy(3, 1),
    easy(4, 1),
    strength(4),
    easy(5, 0.5, { title: 'Soltar piernas' }),
    workout(6, 'long', 'Tirada larga · 3 × 3 km a ritmo de carrera', [
      steady(km(8), 'long'),
      reps(3, { distanceM: km(3) }, 'race', jogOver(km(1))),
      cooldown(km(3)),
    ], 'Específico del recorrido: hazla en la segunda mitad de La Mitja si puedes acercarte. Ritmo de carrera en bajada, con 8 km ya en las piernas.'),
  ],
  // W20 — 59 km. The session the whole phase exists for.
  [
    strength(0),
    workout(1, 'interval', '4 × 2 km a ritmo de carrera', [
      warmup(km(3)),
      reps(4, { distanceM: km(2) }, 'race', jogFor(120)),
      cooldown(km(2)),
    ]),
    easy(2, 1),
    easy(3, 1),
    easy(4, 1),
    strength(4),
    easy(5, 0.5, { title: 'Soltar piernas' }),
    workout(6, 'long', 'Tirada larga · últimos 10 km a ritmo de carrera', [
      steady(km(12), 'long'),
      steady(km(10), 'race', 'Sin cortes a 3:47/km, en bajada y con las piernas cansadas. El ensayo general.'),
      cooldown(km(2)),
    ], 'La sesión que más predice de todo el bloque. Si aguanta esta, aguanta la carrera.'),
  ],
  // W21 — 39 km, down. docs/03 §5: the honest go/no-go. 36:15–36:30 → race for sub-1:20;
  // 37:30 → race for 1:21, which is still a large PB.
  [
    strength(0),
    workout(1, 'interval', '5 × 1 km a ritmo de carrera', [
      warmup(km(2.5)),
      reps(5, { distanceM: km(1) }, 'race', jogFor(90)),
      cooldown(km(1.5)),
    ]),
    easy(2, 1),
    easy(3, 1),
    strength(4, 20, `Solo movilidad, a dos días. ${STRENGTH_NOTES}`),
    easy(5, 0.5, { title: 'Soltar piernas', strides: 4 }),
    race(
      6,
      '10K · sí o no',
      km(10),
      marker(218),
      'docs/03 §5: 36:15–36:30 significa correr a por el sub-1:20. 37:30 significa correr a por 1:21. Se decide aquí, no en la línea de salida.',
    ),
  ],

  // ---- Phase 4 · Taper (W22–W23). Two weeks, against last block's four days.
  // W22 — 40 km.
  [
    strength(0),
    workout(1, 'interval', '5 × 1 km a ritmo de carrera', [
      warmup(km(2.5)),
      reps(5, { distanceM: km(1) }, 'race', jogFor(90), 'Piernas rápidas, no cansadas. Corta mientras siga pareciendo fácil.'),
      cooldown(km(1.5)),
    ]),
    easy(2, 1),
    easy(3, 1),
    easy(4, 1, { strides: 6 }),
    strength(4, 20, `Solo movilidad y activación. ${STRENGTH_NOTES}`),
    rest(5),
    workout(6, 'long', 'Tirada larga · 5 km a ritmo de carrera', [
      steady(km(9), 'long'),
      steady(km(5), 'race'),
      cooldown(km(2)),
    ], 'Última tirada larga. El volumen baja; la chispa no.'),
  ],
  // W23 — race week. Every session fixed: the ramp says 28 km, but 21.1 of that is the
  // race itself, which would leave seven kilometres across six days — a shutdown, not a
  // taper. Fifteen kilometres of easy running before the gun is the honest version.
  [
    strength(0, 20, `Solo movilidad y activación, nada pesado. ${STRENGTH_NOTES}`),
    workout(1, 'tempo', 'Afinado 3 × 1 km a ritmo de carrera', [
      warmup(km(1.5)),
      reps(3, { distanceM: km(1) }, 'race', jogOver(400)),
      cooldown(km(1.1)),
    ], 'El último esfuerzo fuerte. Es un recordatorio, no un entrenamiento.'),
    workout(2, 'easy', 'Rodaje', [steady(km(4), 'easy')]),
    rest(3),
    workout(4, 'easy', 'Soltar piernas + progresiones', [steady(km(2.6), 'easy'), strides(4)], 'Las piernas girando, nada más.'),
    workout(5, 'easy', 'Soltar piernas + progresiones', [steady(km(1.6), 'easy'), strides(4)], 'Veinte minutos. El resto del día con los pies en alto.'),
    {
      day: 6,
      type: 'race',
      title: 'La Mitja de Granollers',
      notes:
        'El sub-1:20 son 3:47/km. Los primeros 10 km suben +140 m: mantén la franja de ritmo y deja que la segunda mitad lo devuelva entre −1 y −1,8 %. Cadencia 85+ en la bajada.',
      pace: PACES.race,
      steps: [
        warmup(km(1.5)),
        strides(4, 20, 'Tres o cuatro, justo antes de la salida.'),
        steady(HALF_MARATHON_M, 'race', '21,1 km a ritmo objetivo.'),
      ],
    },
  ],
]

const WEEKDAY = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

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

export interface PlanSeed {
  weeks: NewPlanWeek[]
  sessions: NewPlanSession[]
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
  const sessions: NewPlanSession[] = []
  const volumeByWeek = new Array<number>(TOTAL_WEEKS).fill(0)

  for (let week = 0; week < TOTAL_WEEKS; week++) {
    const slots = WEEKS[week]!
    const weekStart = BLOCK_START + week * WEEK_MS
    const sizes = sizeEasyRuns(slots, weeklyVolumeM(week))
    // dayOrder disambiguates a double day — the run comes before the strength session.
    const orderByDay = new Map<number, number>()

    for (const slot of slots) {
      const dayOrder = orderByDay.get(slot.day) ?? 0
      orderByDay.set(slot.day, dayOrder + 1)

      const steps = stepsFor(slot, sizes)
      const meta = SESSION_META[slot.type]
      const distanceM = steps && meta.countsAsVolume ? workoutDistanceM(steps) : null
      const band = slot.pace ?? (steps ? bandFor(steps) : null)

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

  const weeks: NewPlanWeek[] = Array.from({ length: TOTAL_WEEKS }, (_, week) => ({
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

const bandFor = (steps: Step[]): PaceBand | null => {
  const zone = primaryZone(steps)
  return zone ? PACES[zone] : null
}

/**
 * Metres run at threshold or faster in a week, over the week's total.
 *
 * docs/03 §3 puts quality at 20–25% of kilometres. Warm-ups, cool-downs and recovery
 * jogs are not quality, which is why this measures the hard steps rather than the
 * distance of the sessions that contain them.
 */
export function hardShare(week: number): number {
  const slots = WEEKS[week]!
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
