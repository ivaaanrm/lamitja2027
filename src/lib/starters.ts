import type { StrengthExercise, StrengthPrescription } from './strength'

/**
 * The two templates the app ships with — as code, never as rows.
 *
 * «Every plan is authored, there is no seed» is a ruling about *dated* plan rows: a week
 * and a session belong to one athlete's block and are written into it, so seeding them
 * would be the app inventing training nobody asked for. An undated, reusable library entry
 * is the other category — `baseline.ts`'s one. Frozen content read out of code, identical
 * for everybody, with no per-user copy that can drift and no idempotent-seed machinery to
 * keep honest. They reach D1 only as copies the athlete asked for: applied onto a session,
 * duplicated from the editor, or written back through `create_template` under a new id.
 *
 * The `treximo-` prefix is what makes that enforceable rather than conventional. An id in
 * this namespace never has a row, so `create_template` / `update_template` /
 * `delete_template` refuse it outright instead of quietly minting a row that shadows a
 * built-in for one athlete and not the others.
 *
 * Browser-safe, like everything the screens read: no drizzle, no zod, no clock, and no
 * import of the exercise catalogue. Each entry carries the Spanish name it is prescribed
 * under, so the list renders with the catalogue nowhere in sight; `exerciseId` only buys
 * the illustration and the instructions. Those ids are checked against the vendored
 * catalogue by `test/unit/exercises.test.ts`, which is the one place that can — a name
 * typed here and a name in RepDB disagreeing is a build failure, not a blank tile.
 */

/** Ids in this namespace are the app's own and never have a row. */
export const BUILTIN_PREFIX = 'treximo-'

export const isBuiltInTemplateId = (id: string): boolean => id.startsWith(BUILTIN_PREFIX)

/**
 * A template as content — what a built-in is, and the part of a `workout_templates` row
 * that means anything once the row has been read. A `WorkoutTemplate` is structurally one
 * of these, which is what lets the built-ins and the athlete's own rows go through the
 * same list, the same editor and the same copy.
 */
export interface TemplateContent {
  id: string
  name: string
  notes: string | null
  targetDurationS: number | null
  exercises: StrengthExercise[]
}

/**
 * What applying a template writes onto a session — a **copy**, which is the whole design
 * of this table stated in five fields.
 *
 * The alternative, a `template_id` on the session resolved at read time, means revising a
 * template in November rewrites the Monday you already trained in September. Training is a
 * record as much as a plan, and a record that changes under you is not one. So the session
 * takes the content and forgets where it came from; the template is a starting point, not
 * a source of truth the session is a view of.
 *
 * Shared rather than written out at each caller because there are two — the MCP
 * `attach_template` tool and the session editor — and a session stamped by an agent must
 * be the same session stamped by a thumb. `type` is not in here: a template says what is
 * done, and the day says whether it is a `strength` day or a `cross` one.
 *
 * `targetDistanceM` is cleared rather than left alone, and that is the one field here that
 * is not copied from anything. Stamping a template onto a session that used to be a run
 * would otherwise leave the run's metres sitting under a list of planks — the mirror of
 * the rule the session editor already follows, where editing the numbers by hand drops the
 * breakdown instead of leaving a stale one behind. The copy is total: after it, every
 * number on the session comes from the template or from nowhere.
 */
export const sessionFromTemplate = (
  template: TemplateContent,
): {
  title: string
  notes: string | null
  targetDurationS: number | null
  targetDistanceM: null
  steps: StrengthPrescription
} => ({
  title: template.name,
  notes: template.notes,
  targetDurationS: template.targetDurationS,
  targetDistanceM: null,
  steps: { kind: 'strength', exercises: template.exercises },
})

/**
 * The knee protocol as a template: load the hip, never stretch the band.
 *
 * It is first because it is the one the block is actually built around — the owner's is a
 * rebuild from a knee injury, and `docs/personal/03` prescribes exactly this twice a week
 * from week one. Nine moves, ordered activation → strength → unilateral control → mobility,
 * so it can be run straight down the list without deciding anything on a mat.
 */
const KNEE_AND_HIPS: TemplateContent = {
  id: 'treximo-rodilla-caderas',
  name: 'Movilidad y robustez de rodilla + caderas',
  notes:
    'Carga la cadera, no estires la cintilla. Dos veces por semana, desde la semana 1. Si la rodilla habla a mitad de una serie, pasa al siguiente ejercicio.',
  targetDurationS: 2100,
  exercises: [
    {
      exerciseId: 'banded-lateral-walk',
      name: 'Caminata Lateral con Banda',
      sets: 2,
      reps: 10,
      durationS: null,
      perSide: true,
      restS: 30,
      load: 'minibanda',
      note: 'Pasos cortos; las rodillas empujan hacia fuera.',
    },
    {
      exerciseId: 'glute-bridge',
      name: 'Puente de Glúteos',
      sets: 2,
      reps: 15,
      durationS: null,
      perSide: false,
      restS: 30,
      load: null,
      note: 'Sube con el glúteo, no con la lumbar.',
    },
    {
      exerciseId: 'side-plank-leg-lift',
      name: 'Plancha Lateral con Elevación de Pierna',
      sets: 3,
      reps: null,
      durationS: 30,
      perSide: true,
      restS: 45,
      load: null,
      note: 'La cadera de abajo alta toda la serie.',
    },
    {
      exerciseId: 'clamshells',
      name: 'Almejas',
      sets: 2,
      reps: 15,
      durationS: null,
      perSide: true,
      restS: 30,
      load: 'minibanda opcional',
      note: 'La pelvis no rota; solo se mueve la cadera.',
    },
    {
      exerciseId: 'single-leg-glute-bridge',
      name: 'Puente de Glúteo a Una Pierna',
      sets: 3,
      reps: 8,
      durationS: null,
      perSide: true,
      restS: 45,
      load: null,
      note: 'Pelvis nivelada; empuja con el talón.',
    },
    {
      exerciseId: 'single-leg-romanian-deadlift',
      name: 'Peso Muerto Rumano a Una Pierna',
      sets: 3,
      reps: 8,
      durationS: null,
      perSide: true,
      restS: 60,
      load: 'sin peso al empezar',
      note: 'La pelvis manda: si rota, acorta el recorrido.',
    },
    {
      exerciseId: 'side-lying-hip-adduction',
      name: 'Aducción de Cadera Acostado de Lado',
      sets: 3,
      reps: 10,
      durationS: null,
      perSide: true,
      restS: 30,
      load: null,
      note: 'Sube despacio; cuando salga fácil, progresa a la plancha de aductores.',
    },
    {
      exerciseId: 'kneeling-hip-flexor-stretch',
      name: 'Estiramiento de Flexores de Cadera Arrodillado',
      sets: 2,
      reps: null,
      durationS: 40,
      perSide: true,
      restS: null,
      load: null,
      note: 'Glúteo apretado; no arquees la lumbar.',
    },
    {
      exerciseId: 'pigeon-stretch',
      name: 'Estiramiento de la Paloma',
      sets: 2,
      reps: null,
      durationS: 40,
      perSide: true,
      restS: null,
      load: null,
      note: 'Respira y afloja; sin rebotes.',
    },
  ],
}

/**
 * The twenty-minute block that rides on a run rather than owning a day.
 *
 * Nothing in it needs equipment or a floor bigger than a mat, which is the point: it is
 * the one that still gets done on a Friday evening after a rodaje.
 */
const FULL_BODY_CORE: TemplateContent = {
  id: 'treximo-core',
  name: 'Cuerpo completo (core)',
  notes:
    'El bloque corto pegado al rodaje del viernes. En circuito, técnica primero: si una serie se rompe, recorta repeticiones, no la postura.',
  targetDurationS: 1200,
  exercises: [
    {
      exerciseId: 'bodyweight-squat',
      name: 'Sentadilla con Peso Corporal',
      sets: 3,
      reps: 15,
      durationS: null,
      perSide: false,
      restS: 30,
      load: null,
      note: 'Talones en el suelo; baja a tu rango limpio.',
    },
    {
      exerciseId: 'push-up',
      name: 'Push-Up',
      sets: 3,
      reps: 10,
      durationS: null,
      perSide: false,
      restS: 45,
      load: null,
      note: 'Si pierdes la línea, sigue en rodillas.',
    },
    {
      exerciseId: 'plank',
      name: 'Plancha',
      sets: 3,
      reps: null,
      durationS: 40,
      perSide: false,
      restS: 30,
      load: null,
      note: 'Glúteo y abdomen apretados; la cadera no se hunde.',
    },
    {
      exerciseId: 'side-plank',
      name: 'Plancha Lateral',
      sets: 3,
      reps: null,
      durationS: 30,
      perSide: true,
      restS: 30,
      load: null,
      note: 'Codo bajo el hombro; cuerpo en una línea.',
    },
    {
      exerciseId: 'dead-bug',
      name: 'Dead Bug',
      sets: 3,
      reps: 10,
      durationS: null,
      perSide: true,
      restS: 30,
      load: null,
      note: 'La lumbar pegada al suelo todo el tiempo.',
    },
    {
      exerciseId: 'bird-dog',
      name: 'Bird-Dog',
      sets: 3,
      reps: 8,
      durationS: null,
      perSide: true,
      restS: 30,
      load: null,
      note: 'Lento; la pelvis no se abre.',
    },
    {
      exerciseId: 'hollow-body-hold',
      name: 'Mantenimiento del Cuerpo Hueco',
      sets: 3,
      reps: null,
      durationS: 20,
      perSide: false,
      restS: 45,
      load: null,
      note: 'Si la lumbar despega, dobla las rodillas.',
    },
    {
      exerciseId: 'superman',
      name: 'Superman',
      sets: 3,
      reps: 12,
      durationS: null,
      perSide: false,
      restS: null,
      load: null,
      note: 'Pausa de un segundo arriba.',
    },
  ],
}

export const BUILTIN_TEMPLATES: readonly TemplateContent[] = [KNEE_AND_HIPS, FULL_BODY_CORE]

export const builtInTemplate = (id: string): TemplateContent | undefined =>
  BUILTIN_TEMPLATES.find((template) => template.id === id)
