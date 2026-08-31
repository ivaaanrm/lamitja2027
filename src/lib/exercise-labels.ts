/**
 * The catalogue's facets, in Spanish.
 *
 * RepDB files everything under English slugs — `gluteus_maximus`, `pull_up_bar`,
 * `knee_safe` — and this app speaks Spanish to the person reading it. So every slug that
 * can reach a screen gets a label here, written once, by hand: a chip reading
 * *lower_back_safe* is the same failure as an English button.
 *
 * **It lives outside `src/lib/exercises/`, and that is the point.** That directory is
 * Worker-only (~650 KB of prose); the filter chips and the detail sheet need these ~120
 * strings *in the browser* and nothing else. This module therefore imports nothing at all
 * — the `session-types.ts` charter — so it can be pulled into a component with no
 * catalogue behind it.
 *
 * `test/unit/exercises.test.ts` joins the two halves: every slug in the generated
 * vocabularies must have a label here. A RepDB release that mints a new slug fails
 * `pnpm test` loudly rather than rendering a blank chip on somebody's phone. The lookups
 * still fall back to the slug, because a red test is the right place to find out and a
 * blank label is never the right thing to render.
 */

/** Primary and secondary muscles. Club Spanish, not a textbook: «gemelos», not «gastrocnemio». */
export const MUSCLE_LABELS: Record<string, string> = {
  abductors: 'Abductores',
  adductors: 'Aductores',
  anterior_deltoid: 'Deltoides anterior',
  biceps_brachii: 'Bíceps braquial',
  brachialis: 'Braquial anterior',
  brachioradialis: 'Supinador largo',
  erector_spinae: 'Erectores espinales',
  forearm_extensors: 'Extensores del antebrazo',
  forearm_flexors: 'Flexores del antebrazo',
  forearms: 'Antebrazos',
  gastrocnemius: 'Gemelos',
  gluteus_maximus: 'Glúteo mayor',
  gluteus_medius: 'Glúteo medio',
  hamstrings: 'Isquiotibiales',
  hip_flexors: 'Flexores de cadera',
  lateral_deltoid: 'Deltoides lateral',
  latissimus_dorsi: 'Dorsal ancho',
  obliques: 'Oblicuos',
  pectoralis_major: 'Pectoral mayor',
  posterior_deltoid: 'Deltoides posterior',
  quadratus_lumborum: 'Cuadrado lumbar',
  quadriceps: 'Cuádriceps',
  rectus_abdominis: 'Recto abdominal',
  rhomboids: 'Romboides',
  serratus_anterior: 'Serrato anterior',
  soleus: 'Sóleo',
  supraspinatus: 'Supraespinoso',
  transverse_abdominis: 'Transverso abdominal',
  trapezius: 'Trapecio',
  triceps_brachii: 'Tríceps braquial',
}

/**
 * Tags. Four of them are the reason this catalogue was chosen — `knee_safe`,
 * `lower_back_safe`, `no_axial_load` and `shoulder_safe` are on 265–300 rows each, which
 * makes "what may I do with this knee" a filter rather than a judgement call.
 */
export const TAG_LABELS: Record<string, string> = {
  arm_day: 'Día de brazos',
  back_day: 'Día de espalda',
  back_focus: 'Espalda',
  ballistic: 'Balístico',
  big_three: 'Básicos',
  bodyweight: 'Peso corporal',
  calf_focus: 'Gemelos',
  calisthenics: 'Calistenia',
  chest_focus: 'Pecho',
  conditioning: 'Acondicionamiento',
  core: 'Core',
  core_focus: 'Core',
  full_body: 'Cuerpo completo',
  glute_focus: 'Glúteos',
  grip_focus: 'Agarre',
  knee_safe: 'Apta para rodilla',
  leg_day: 'Día de piernas',
  lower_back_safe: 'Apta para lumbar',
  mobility: 'Movilidad',
  no_axial_load: 'Sin carga axial',
  powerlifting: 'Powerlifting',
  pull_day: 'Día de tirón',
  push_day: 'Día de empuje',
  rehab: 'Rehabilitación',
  requires_bench: 'Necesita banco',
  shoulder_focus: 'Hombros',
  shoulder_safe: 'Apta para hombro',
  shoulder_stability: 'Estabilidad de hombro',
  stretching: 'Estiramiento',
  warm_up: 'Calentamiento',
}

/** What the move needs. `null` equipment is bodyweight — see `EQUIPMENT_NONE_LABEL`. */
export const EQUIPMENT_LABELS: Record<string, string> = {
  ab_crunch_machine: 'Máquina de abdominales',
  ab_wheel: 'Rueda abdominal',
  assisted_pullup_machine: 'Máquina de dominadas asistidas',
  back_extension_machine: 'Banco de hiperextensiones',
  barbell: 'Barra',
  bicep_curl_machine: 'Máquina de bíceps',
  cable: 'Polea',
  chest_fly_machine: 'Máquina de aperturas',
  chest_press_machine: 'Máquina de press de pecho',
  climbing_rope: 'Cuerda de escalada',
  dip_machine: 'Máquina de fondos',
  dip_station: 'Paralelas',
  donkey_calf_raise_machine: 'Máquina de gemelo tipo burro',
  dumbbell: 'Mancuerna',
  ez_bar: 'Barra Z',
  flat_bench: 'Banco plano',
  glute_ham_developer: 'Banco GHD',
  hack_squat: 'Máquina de hack squat',
  hip_abduction_machine: 'Máquina de abductores',
  hip_adduction_machine: 'Máquina de aductores',
  hip_thrust_machine: 'Máquina de hip thrust',
  kettlebell: 'Kettlebell',
  lat_pulldown_machine: 'Máquina de jalón al pecho',
  leg_curl: 'Máquina de curl femoral',
  leg_extension: 'Máquina de extensión de cuádriceps',
  leg_press: 'Prensa de piernas',
  loop_band: 'Minibanda',
  pec_deck: 'Contractora de pecho',
  plate_loaded_lateral_raise_machine: 'Máquina de elevaciones laterales',
  plates: 'Discos',
  plyo_box: 'Cajón pliométrico',
  preacher_curl_machine: 'Banco Scott',
  pull_up_bar: 'Barra de dominadas',
  resistance_band: 'Banda elástica',
  rings: 'Anillas',
  seated_calf_raise_machine: 'Máquina de gemelo sentado',
  shoulder_press_machine: 'Máquina de press de hombro',
  shrug_machine: 'Máquina de encogimientos',
  slam_ball: 'Balón medicinal',
  sled: 'Trineo',
  smith_machine: 'Multipower',
  stability_ball: 'Fitball',
  standing_calf_raise_machine: 'Máquina de gemelo de pie',
  suspension_trainer: 'Entrenamiento en suspensión',
  trap_bar: 'Barra hexagonal',
  tricep_extension_machine: 'Máquina de tríceps',
  wrist_roller: 'Rodillo de muñeca',
}

/** No equipment at all — the filter an athlete on a hotel-room floor wants. */
export const EQUIPMENT_NONE_LABEL = 'Sin material'

export const BODY_PART_LABELS: Record<string, string> = {
  back: 'Espalda',
  chest: 'Pecho',
  core: 'Core',
  full_body: 'Cuerpo completo',
  lower_arms: 'Antebrazos',
  lower_legs: 'Gemelos',
  shoulders: 'Hombros',
  upper_arms: 'Brazos',
  upper_legs: 'Piernas',
}

export const CATEGORY_LABELS: Record<string, string> = {
  plyometrics: 'Pliometría',
  strength: 'Fuerza',
  stretching: 'Estiramientos',
}

export const DIFFICULTY_LABELS: Record<string, string> = {
  advanced: 'Avanzado',
  beginner: 'Principiante',
  intermediate: 'Intermedio',
}

const lookup =
  (labels: Record<string, string>) =>
  (slug: string): string =>
    labels[slug] ?? slug

export const muscleLabel = lookup(MUSCLE_LABELS)
export const tagLabel = lookup(TAG_LABELS)
export const bodyPartLabel = lookup(BODY_PART_LABELS)
export const categoryLabel = lookup(CATEGORY_LABELS)
export const difficultyLabel = lookup(DIFFICULTY_LABELS)

/** Takes the column as stored, so `null` is answered rather than left to the caller. */
export const equipmentLabel = (slug: string | null): string =>
  slug == null ? EQUIPMENT_NONE_LABEL : (EQUIPMENT_LABELS[slug] ?? slug)
