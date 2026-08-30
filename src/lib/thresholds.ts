import { DAY_MS, WEEK_MS, startOfDay, weekStart, type BlockConfig } from './block'
import { isRun } from './activity'
import { hrZone } from './paces'
import type { Activity } from './db/schema'

/**
 * The two lactate thresholds, estimated from the activity summaries the app already has.
 *
 * Pure, browser-safe and clock-free like the rest of the read-time analytics: it takes
 * `Activity[]`, a maximum heart rate and a `now`, and it never fetches anything. That is
 * the binding constraint on the whole design, so it is worth saying what it costs before
 * the method: **the app stores summaries, not streams**. One row per run — average heart
 * rate, maximum heart rate, distance, moving time — and no sample series, because a table
 * of streams would be a second copy of Strava's record (see `streams.ts`, which fetches
 * them for one screen and stores nothing). So none of the textbook field protocols are
 * available here: there is no rolling best-20-minute heart rate, no lap-by-lap scatter and
 * no heart-rate/pace decoupling. What there is, is roughly 150 rows a block, each of which
 * is one honest (pace, heart rate, duration) triple.
 *
 * ## What LT1 and LT2 are, and which of them a training log can see
 *
 * LT2 — the second lactate turn point, the anaerobic threshold, MLSS — is the fastest
 * intensity that can be held in a metabolic steady state, conventionally about an hour.
 * That definition is a *field* definition: it is measurable from a hard effort, which is
 * exactly what a training log records. It is estimable here, and it is estimated from
 * demonstrated efforts rather than from a formula.
 *
 * LT1 — the first turn point, the aerobic threshold, the top of genuinely easy running —
 * is defined by a *bend* in a curve rather than by a maximum, and a bend needs points on
 * both sides of it. Whole-run averages give a much flatter, better-behaved scatter than
 * the underlying physiology has: the surges and the drift inside a run average out, so
 * heart rate against speed comes back very nearly linear all the way from easy running to
 * race pace, and a bend that is not in the data cannot be found in it. So LT1 is estimated
 * two ways here, in order: a segmented fit when the scatter actually supports a breakpoint,
 * and otherwise an anchored offset below LT2. `basis` says which happened, and the UI says
 * so too — an estimate that will not admit which half of it is measured is worse than no
 * estimate.
 *
 * ## The method, in three parts
 *
 * **1. The cardiac cost line.** A recency-weighted least-squares fit of average heart rate
 * against average speed over every qualifying run in a trailing window. This is the piece
 * that makes the whole thing adaptive: as aerobic fitness improves the line shifts right —
 * the same heart rate buys a faster pace — and everything read off it moves with it.
 *
 * Mixed sessions are deliberately *kept* in the fit rather than filtered out. It looks
 * wrong and it is not: a session's fast repetitions and its slow recoveries offset each
 * other in the average almost linearly, so an interval session lands within a couple of
 * beats of the line the continuous runs draw. Throwing them away would halve the sample of
 * an athlete who trains three quality sessions a week.
 *
 * **2. LT2, from what was actually sustained.** Not from the line — the line is an average
 * over a window and LT2 is a maximum. A run qualifies as evidence when it was run *whole*
 * as one hard, steady effort, and the discriminator for that is the one the summary rows
 * happen to carry: `maxHeartrate − averageHeartrate`. A race sits at 13–15 beats of spread;
 * a tempo run buried inside a warm-up and a cool-down sits at 26 and is correctly thrown
 * out, because its average heart rate is a statement about the warm-up as much as about the
 * threshold. Each surviving effort is corrected to its 60-minute equivalent and the best
 * few are averaged.
 *
 * **3. LT1.** The segmented fit, or the anchor. See `estimateLt1`.
 *
 * ## Calibration
 *
 * The constants below were checked against the owner's 2025-26 season, which has two
 * independent hard efforts two months apart: a 10K raced in 39:42 at 176 avg, and a half
 * in 1:23:57 at 172 avg. Those are very different durations at very nearly the same pace,
 * so they are a real test of the duration correction rather than one number fitted twice.
 * They resolve to 173.5 and 174.0 — a beat apart, from efforts eleven weeks apart — and
 * 174 against a maximum of 192 is 90.6%, which is where the literature puts LT2 for a
 * trained runner. The pace the line puts under that heart rate is 3:57–4:00/km, and the
 * half was run at 3:57.6.
 *
 * The correction is also insensitive to its own constant, which is the reason to trust it:
 * at `LT2_DURATION_K` anywhere from 4 to 8 the two efforts still land within 2 beats of
 * each other and of 174.
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** One threshold, said the three ways it is used: a pulse, a pace, and a share of max. */
export interface Threshold {
  /** Beats per minute — what the strap is asked to hold. */
  bpm: number
  /**
   * Seconds per kilometre at that heart rate, read off the cost line. `null` when there is
   * no line yet, which is most of the first fortnight of a block.
   *
   * This is the number that actually moves week to week. Threshold *heart rates* are
   * fairly stable within an athlete — they are a property of the muscle, not of the week —
   * and what training changes is the speed carried at them. A card that only printed the
   * bpm would look motionless through a block in which everything improved.
   */
  paceSKm: number | null
  /** Share of maximum heart rate, 0–1. The cross-check a coach reads first. */
  shareOfMax: number
  /** Where the number came from — printed on screen, never inferred by the reader. */
  basis: ThresholdBasis
}

/**
 * How a threshold was arrived at, worst to best.
 *
 * - `hrmax` — a share of maximum heart rate and nothing else. The opening position.
 * - `anchored` — placed relative to a measured LT2. Only LT1 is ever this.
 * - `measured` — read out of efforts this athlete actually ran.
 */
export type ThresholdBasis = 'hrmax' | 'anchored' | 'measured'

/** The recency-weighted fit of average heart rate against average speed. */
export interface CostLine {
  /** Heart rate at a standstill, extrapolated — an artefact of the fit, not a resting HR. */
  interceptBpm: number
  /** Beats per minute per m/s. */
  slopeBpmPerMs: number
  /** Weighted correlation, 0–1. Under `MIN_LINE_R` the line is refused outright. */
  r: number
  /** How many runs are behind it. */
  runs: number
  /** The speeds actually observed, m/s — the range the line may be read inside. */
  fastestMs: number
  slowestMs: number
}

/** One sustained effort, as evidence for LT2. */
export interface EffortEvidence {
  activityId: number
  startedOn: number
  /** Average heart rate over the whole run. */
  bpm: number
  /** That heart rate corrected to what an hour of it would have been. */
  bpm60: number
  movingS: number
  paceSKm: number
}

export interface Thresholds {
  lt1: Threshold
  lt2: Threshold
  /** `null` when too few runs carry a heart rate to fit anything. */
  line: CostLine | null
  /** The efforts LT2 was read from, most recent first. Empty when it fell back to FCmáx. */
  evidence: EffortEvidence[]
  /** How much of this is measurement and how much is prior. Drives the wording on screen. */
  confidence: 'alta' | 'media' | 'baja'
  /** Runs in the window that carried a heart rate at all. */
  sampleRuns: number
  /**
   * The highest heart rate any run in the window actually recorded, or `null`.
   *
   * Surfaced because it is the one input the athlete can fix and the app cannot: every
   * share here is a share of `users.hr_max`, so a strap that has seen a beat *above* the
   * configured maximum means every zone on every screen is drawn a step too high. The card
   * says so rather than silently clamping.
   */
  observedMaxBpm: number | null
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * How far back the estimate looks, and how fast the past stops counting.
 *
 * Twelve weeks with a four-week half-life: long enough that a block with one hard effort
 * in it still has an answer, short enough that the answer is about now. The half-life is
 * what makes it track rather than accumulate — an effort from ten weeks ago carries about
 * an sixth of the weight of one from last Tuesday.
 */
const WINDOW_WEEKS = 12
const HALF_LIFE_DAYS = 28

/** Under this many runs with a heart rate, there is no line and no pace for a threshold. */
const MIN_LINE_RUNS = 6

/**
 * The weakest correlation a cost line may have and still be drawn on.
 *
 * A block whose runs are all at one pace has no spread to fit through, and a fit through
 * no spread is a slope invented out of noise — which would then be inverted to produce a
 * threshold *pace*, and an inverted noisy slope is arbitrarily wrong. Refusing is cheap:
 * the bpm estimates do not depend on the line at all.
 */
const MIN_LINE_R = 0.6

/** A run shorter than this is mostly its own warm-up ramp, and its average says so. */
const MIN_LINE_S = 15 * 60

/** Full weight at half an hour; below that the ramp is a growing share of the average. */
const FULL_WEIGHT_S = 30 * 60

/**
 * `maxHeartrate − averageHeartrate`, the steadiness test.
 *
 * The whole LT2 estimate turns on this one number. A run held at one effort has a small
 * spread — the owner's half marathon is 13 beats, his 10K 15 — and a session with
 * repetitions in it has a large one: the 4 km tempo inside a warm-up and a cool-down is
 * 26, and its average heart rate of 156 is thirty beats below the 177 the tempo kilometres
 * were actually run at. Eighteen separates them with room on both sides.
 */
const STEADY_SPREAD_BPM = 18

/** An effort under twenty minutes says nothing about an hour; over two and a half hours
 *  it is a different question. */
const MIN_EFFORT_S = 20 * 60
const MAX_EFFORT_S = 150 * 60

/**
 * Beats per minute per e-fold of duration — the correction from "held for this long" to
 * "could be held for an hour".
 *
 * Six, from the owner's own two efforts: a 40-minute 10K at 176 and an 84-minute half at
 * 172 are the same athlete eleven weeks apart, and they only agree under a correction of
 * roughly this size. See the calibration note at the top; anything from 4 to 8 keeps them
 * within two beats of each other, which is why this is a constant and not a fitted
 * parameter pretending to precision it has not got.
 */
const LT2_DURATION_K = 6

/** How many efforts the estimate averages. One is an anecdote; five reaches back too far. */
const LT2_TOP_EFFORTS = 3

/**
 * How many efforts' worth of weight the textbook share of maximum keeps, once there is
 * evidence to weigh it against.
 *
 * One, which is to say: a single hard run is worth exactly as much as the prior, two runs
 * outvote it two to one, and by four the prior is background. This is the guard against the
 * failure mode this estimator would otherwise have every August — the first hard run back
 * from a lay-off, in the heat, on a dry strap, reading 181 average for 39 minutes and
 * declaring a threshold at 93% of maximum on the strength of one afternoon.
 *
 * It costs almost nothing once the evidence is real: the owner's two January efforts sit at
 * 174.0 and 173.5 against a prior of 172.8, so shrinking them still rounds to 174.
 */
const LT2_PRIOR_EFFORTS = 1

/** LT2 as a share of maximum, when nothing has been run hard enough to measure it. */
const LT2_DEFAULT_SHARE = 0.9

/** The window a measured LT2 is allowed to land in. Outside it, the strap was lying. */
const LT2_MIN_SHARE = 0.84
const LT2_MAX_SHARE = 0.95

/**
 * How far below LT2 the aerobic threshold sits, as a share of maximum heart rate, when the
 * scatter will not give up a breakpoint of its own.
 *
 * A tenth of maximum is the textbook gap for a trained endurance runner — LT2 near 90% and
 * LT1 near 80% — and it lands on 155 for the owner, whose easy running sits at 146–150 at
 * 5:05/km. Easy running *below* LT1 is the right relationship and the reason to believe the
 * anchor: an athlete's easy days should sit under their aerobic threshold, not on it.
 *
 * An offset in beats rather than a ratio of LT2, for the reason `paces.ts` gives for its
 * bands being ratios: the quantity that scales here is the *reserve*, and 0.9 × LT2 would
 * put a low-maximum athlete's LT1 far too close to their LT2.
 */
const LT1_GAP_SHARE = 0.1

/** The window LT1 may land in, however it was arrived at. */
const LT1_MIN_SHARE = 0.72
const LT1_MAX_SHARE = 0.86

/** LT1 is never closer to LT2 than this, whatever the arithmetic says. */
const LT_MIN_SEPARATION_BPM = 6

/**
 * How much better a two-segment fit has to be before its breakpoint is believed as LT1.
 *
 * Any second segment reduces the residual sum of squares — it has two more parameters — so
 * "it fits better" is not evidence of anything. A fifth of the residual is the bar for
 * calling the bend real rather than fitted, and even then the breakpoint still has to land
 * inside the plausible LT1 band before it is used.
 */
const SEGMENT_RSS_GAIN = 0.2

/** Points required on each side of a breakpoint for it to be a breakpoint at all. */
const MIN_SEGMENT_POINTS = 4

// ---------------------------------------------------------------------------
// The sample
// ---------------------------------------------------------------------------

interface Sample {
  activityId: number
  startedOn: number
  /** m/s. */
  speedMs: number
  bpm: number
  maxBpm: number | null
  movingS: number
  /** Recency × duration. */
  weight: number
}

/** Exponential recency, halving every `HALF_LIFE_DAYS`. */
const recency = (startedOn: number, now: number) =>
  Math.pow(0.5, Math.max(0, (startOfDay(now) - startOfDay(startedOn)) / DAY_MS) / HALF_LIFE_DAYS)

/**
 * Every run in the window that carries a heart rate, as points on the cost plot.
 *
 * Rides and hikes are excluded rather than costed: cycling heart rate at a given effort
 * sits well below running heart rate, and a bike ride on the plot would drag the line down
 * at a speed no run ever reaches.
 */
function sample(activities: Activity[], now: number, windowWeeks: number): Sample[] {
  const opens = startOfDay(now) - windowWeeks * WEEK_MS
  const out: Sample[] = []

  for (const activity of activities) {
    if (!isRun(activity.sportType)) continue
    if (activity.averageHeartrate == null) continue
    if (activity.movingS < MIN_LINE_S || activity.distanceM <= 0) continue
    if (activity.startedOn < opens || activity.startedOn > now + DAY_MS) continue

    out.push({
      activityId: activity.id,
      startedOn: activity.startedOn,
      speedMs: activity.distanceM / activity.movingS,
      bpm: activity.averageHeartrate,
      maxBpm: activity.maxHeartrate,
      movingS: activity.movingS,
      weight:
        recency(activity.startedOn, now) * Math.min(1, activity.movingS / FULL_WEIGHT_S),
    })
  }

  return out
}

// ---------------------------------------------------------------------------
// The cardiac cost line
// ---------------------------------------------------------------------------

interface Fit {
  intercept: number
  slope: number
  /** Weighted residual sum of squares. */
  rss: number
}

/** Weighted least squares of `y = a + b·x`. `null` when x has no spread to fit through. */
function fit(points: { x: number; y: number; weight: number }[]): Fit | null {
  let sw = 0
  let sx = 0
  let sy = 0
  let sxx = 0
  let sxy = 0
  for (const p of points) {
    sw += p.weight
    sx += p.weight * p.x
    sy += p.weight * p.y
    sxx += p.weight * p.x * p.x
    sxy += p.weight * p.x * p.y
  }
  if (sw <= 0) return null

  const denominator = sw * sxx - sx * sx
  if (Math.abs(denominator) < 1e-9) return null

  const slope = (sw * sxy - sx * sy) / denominator
  const intercept = (sy - slope * sx) / sw
  const rss = points.reduce(
    (sum, p) => sum + p.weight * Math.pow(p.y - (intercept + slope * p.x), 2),
    0,
  )
  return { intercept, slope, rss }
}

/** Weighted Pearson correlation — how much of the scatter the line actually explains. */
function correlation(points: { x: number; y: number; weight: number }[]): number {
  let sw = 0
  let sx = 0
  let sy = 0
  for (const p of points) {
    sw += p.weight
    sx += p.weight * p.x
    sy += p.weight * p.y
  }
  if (sw <= 0) return 0
  const mx = sx / sw
  const my = sy / sw

  let sxy = 0
  let sxx = 0
  let syy = 0
  for (const p of points) {
    sxy += p.weight * (p.x - mx) * (p.y - my)
    sxx += p.weight * Math.pow(p.x - mx, 2)
    syy += p.weight * Math.pow(p.y - my, 2)
  }
  const denominator = Math.sqrt(sxx * syy)
  return denominator < 1e-9 ? 0 : sxy / denominator
}

/**
 * The line, or `null`.
 *
 * A negative slope is refused along with a weak one: heart rate rising with speed is the
 * entire premise, and a fit that says otherwise is reporting noise or a strap that dropped
 * out. Inverting it to get a pace would produce a confident, backwards number.
 */
export function costLine(samples: Sample[]): CostLine | null {
  if (samples.length < MIN_LINE_RUNS) return null

  const points = samples.map((s) => ({ x: s.speedMs, y: s.bpm, weight: s.weight }))
  const line = fit(points)
  if (!line || line.slope <= 0) return null

  const r = correlation(points)
  if (r < MIN_LINE_R) return null

  return {
    interceptBpm: line.intercept,
    slopeBpmPerMs: line.slope,
    r,
    runs: samples.length,
    fastestMs: Math.max(...samples.map((s) => s.speedMs)),
    slowestMs: Math.min(...samples.map((s) => s.speedMs)),
  }
}

/**
 * The pace the line puts under a heart rate, seconds per kilometre.
 *
 * Refused more than 15% outside the speeds actually observed. Extrapolation on a fitted
 * line is where this kind of estimate goes quietly wrong — beyond the sample the linear
 * assumption is not merely uncertain, it is known to be false, since heart rate flattens
 * as it approaches maximum — so a threshold nobody has run near gets a bpm and no pace
 * rather than a confident fiction.
 */
export function paceAt(line: CostLine, bpm: number): number | null {
  const speed = (bpm - line.interceptBpm) / line.slopeBpmPerMs
  if (!Number.isFinite(speed) || speed <= 0) return null
  if (speed > line.fastestMs * 1.15 || speed < line.slowestMs * 0.85) return null
  return 1000 / speed
}

// ---------------------------------------------------------------------------
// LT2 — the anaerobic threshold, from efforts actually sustained
// ---------------------------------------------------------------------------

/**
 * What an effort's average heart rate implies for a full hour.
 *
 * Longer than an hour means the number is an underestimate of the hour, shorter means an
 * overestimate, and the correction is logarithmic in duration because sustainable intensity
 * falls off with the logarithm of time rather than linearly with it.
 */
const toHourEquivalent = (bpm: number, movingS: number) =>
  bpm - LT2_DURATION_K * Math.log(3600 / movingS)

/**
 * The efforts that are evidence: run whole, run hard, run steady, run long enough.
 *
 * `hrZone(...) >= 4` is what "hard" means everywhere else in the app, so it is what it
 * means here — an effort whose average sits below the Z4 floor was not run at a threshold
 * whatever else it was.
 */
function efforts(samples: Sample[], hrMax: number): EffortEvidence[] {
  const out: EffortEvidence[] = []

  for (const s of samples) {
    if (s.movingS < MIN_EFFORT_S || s.movingS > MAX_EFFORT_S) continue
    if (s.maxBpm == null || s.maxBpm - s.bpm > STEADY_SPREAD_BPM) continue
    if (hrZone(s.bpm, hrMax) < 4) continue

    out.push({
      activityId: s.activityId,
      startedOn: s.startedOn,
      bpm: s.bpm,
      bpm60: toHourEquivalent(s.bpm, s.movingS),
      movingS: s.movingS,
      paceSKm: 1000 / s.speedMs,
    })
  }

  return out.sort((a, b) => b.startedOn - a.startedOn)
}

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value))

/** LT2 in bpm, plus the efforts it was read from. */
function estimateLt2(
  samples: Sample[],
  hrMax: number,
  now: number,
): { bpm: number; basis: ThresholdBasis; evidence: EffortEvidence[] } {
  const evidence = efforts(samples, hrMax)
  if (evidence.length === 0)
    return { bpm: Math.round(LT2_DEFAULT_SHARE * hrMax), basis: 'hrmax', evidence: [] }

  // The best few rather than the single best: one effort on a hot day, or one strap
  // reading high for a kilometre, should not be able to move a threshold on its own.
  // Still recency-weighted inside the top few, so a fresher effort of equal quality wins.
  const best = [...evidence].sort((a, b) => b.bpm60 - a.bpm60).slice(0, LT2_TOP_EFFORTS)
  let weighted = 0
  let total = 0
  for (const effort of best) {
    const weight = recency(effort.startedOn, now)
    weighted += weight * effort.bpm60
    total += weight
  }

  // Shrink towards the textbook share of maximum, with the prior worth `LT2_PRIOR_EFFORTS`
  // of the efforts measured. The measurement wins as soon as it is corroborated, and one
  // freak reading never gets to speak for the block on its own.
  const measured = weighted / total
  const prior = LT2_DEFAULT_SHARE * hrMax
  const shrunk =
    (measured * best.length + prior * LT2_PRIOR_EFFORTS) / (best.length + LT2_PRIOR_EFFORTS)

  const bpm = clamp(shrunk, LT2_MIN_SHARE * hrMax, LT2_MAX_SHARE * hrMax)
  return { bpm: Math.round(bpm), basis: 'measured', evidence }
}

// ---------------------------------------------------------------------------
// LT1 — the aerobic threshold, from a bend if there is one
// ---------------------------------------------------------------------------

/**
 * The breakpoint in the heart-rate/speed scatter, if the scatter has one.
 *
 * A grid search over candidate speeds, fitting a separate line each side and keeping the
 * split that minimises the combined residual. Two guards make it honest rather than
 * decorative: the split has to beat the single line by a real margin (`SEGMENT_RSS_GAIN`,
 * because two extra parameters always fit better), and the *shallower* segment has to be
 * the slow one — that is what a physiological bend looks like, heart rate climbing faster
 * per unit speed once the aerobic ceiling is passed. A bend the other way is noise wearing
 * the shape of a finding.
 *
 * Exported for the test, which drives it with a scatter built around a known breakpoint.
 */
export function breakpointBpm(samples: Sample[], baseline: Fit | null): number | null {
  if (!baseline || samples.length < MIN_SEGMENT_POINTS * 2) return null

  const points = samples
    .map((s) => ({ x: s.speedMs, y: s.bpm, weight: s.weight }))
    .sort((a, b) => a.x - b.x)

  let best: { rss: number; bpm: number } | null = null

  for (let split = MIN_SEGMENT_POINTS; split <= points.length - MIN_SEGMENT_POINTS; split++) {
    const lower = fit(points.slice(0, split))
    const upper = fit(points.slice(split))
    if (!lower || !upper) continue
    if (lower.slope <= 0 || upper.slope <= lower.slope) continue

    const rss = lower.rss + upper.rss
    if (best && rss >= best.rss) continue

    // Where the two segments cross is the breakpoint; it has to fall between the points
    // that produced them, or the "bend" is two lines meeting outside the data.
    const speed = (upper.intercept - lower.intercept) / (lower.slope - upper.slope)
    const from = points[split - 1]!.x
    const to = points[split]!.x
    if (!Number.isFinite(speed) || speed < from || speed > to) continue

    best = { rss, bpm: lower.intercept + lower.slope * speed }
  }

  if (!best) return null
  return best.rss <= baseline.rss * (1 - SEGMENT_RSS_GAIN) ? best.bpm : null
}

/**
 * LT1, preferring a measured bend and falling back to an anchor below LT2.
 *
 * The fallback is not a shrug. LT1 is the top of the range an athlete spends most of their
 * week in, so getting it roughly right matters more than getting it precisely right, and a
 * tenth of maximum below a *measured* LT2 is a better number than a bend read out of a
 * scatter that has not got one. What the anchor cannot do is move on its own — so when it
 * is what is being used, the card says the pulse is anchored and points at the pace, which
 * moves with the line either way.
 */
function estimateLt1(
  samples: Sample[],
  lt2Bpm: number,
  hrMax: number,
): { bpm: number; basis: ThresholdBasis } {
  const points = samples.map((s) => ({ x: s.speedMs, y: s.bpm, weight: s.weight }))
  const detected = breakpointBpm(samples, fit(points))

  const ceiling = Math.min(LT1_MAX_SHARE * hrMax, lt2Bpm - LT_MIN_SEPARATION_BPM)
  const floor = LT1_MIN_SHARE * hrMax

  if (detected != null && detected >= floor && detected <= ceiling)
    return { bpm: Math.round(detected), basis: 'measured' }

  return {
    bpm: Math.round(clamp(lt2Bpm - LT1_GAP_SHARE * hrMax, floor, ceiling)),
    basis: 'anchored',
  }
}

// ---------------------------------------------------------------------------
// The estimate
// ---------------------------------------------------------------------------

/**
 * Both thresholds as of `now`, from this athlete's own runs.
 *
 * Degrades in one direction and never throws: with no runs at all it answers with the two
 * shares of maximum heart rate and `confianza: baja`, which is a real answer — those shares
 * are how every athlete starts, and the card is legible in week one of a block rather than
 * empty until November.
 */
export function estimateThresholds(
  activities: Activity[],
  hrMax: number,
  now: number,
  windowWeeks: number = WINDOW_WEEKS,
): Thresholds {
  const samples = sample(activities, now, windowWeeks)
  const line = costLine(samples)

  const lt2 = estimateLt2(samples, hrMax, now)
  const lt1 = estimateLt1(samples, lt2.bpm, hrMax)

  const confidence: Thresholds['confidence'] =
    lt2.basis === 'measured' && line && lt2.evidence.length >= 2
      ? 'alta'
      : lt2.basis === 'measured' || line
        ? 'media'
        : 'baja'

  return {
    lt1: {
      bpm: lt1.bpm,
      paceSKm: line ? paceAt(line, lt1.bpm) : null,
      shareOfMax: lt1.bpm / hrMax,
      basis: lt1.basis,
    },
    lt2: {
      bpm: lt2.bpm,
      paceSKm: line ? paceAt(line, lt2.bpm) : null,
      shareOfMax: lt2.bpm / hrMax,
      basis: lt2.basis,
    },
    line,
    evidence: lt2.evidence,
    confidence,
    sampleRuns: samples.length,
    observedMaxBpm: samples.reduce<number | null>(
      (best, s) => (s.maxBpm == null ? best : best == null ? s.maxBpm : Math.max(best, s.maxBpm)),
      null,
    ),
  }
}

// ---------------------------------------------------------------------------
// The evolution
// ---------------------------------------------------------------------------

export interface ThresholdWeek {
  weekIndex: number
  lt1Bpm: number
  lt2Bpm: number
  /** `null` until there is a cost line — the weeks before the estimate has a pace. */
  lt1PaceSKm: number | null
  lt2PaceSKm: number | null
  basis: ThresholdBasis
}

/**
 * The estimate re-run at the end of every week of the block up to `now`.
 *
 * Each week is computed from the activities that existed *by that Sunday* and nothing
 * later, so the series is what the athlete would have been told at the time rather than a
 * back-projection of today's answer. That distinction is the whole value of the chart: a
 * line that improves because the estimate improved is not the same claim as a line that
 * improves because the athlete did, and only the honest one is worth drawing.
 *
 * Weeks before there is anything to say are omitted rather than filled with the fallback,
 * so the series opens where the evidence does.
 */
export function thresholdSeries(
  block: BlockConfig,
  activities: Activity[],
  hrMax: number,
  now: number,
): ThresholdWeek[] {
  const out: ThresholdWeek[] = []
  const today = startOfDay(now)

  for (let i = 0; ; i++) {
    const ends = weekStart(block, i) + WEEK_MS - DAY_MS
    if (weekStart(block, i) > today) break

    const at = Math.min(ends, today)
    const upTo = activities.filter((a) => a.startedOn <= at + DAY_MS)
    const estimate = estimateThresholds(upTo, hrMax, at)

    // Nothing measured and no line is the opening default repeated; drawing it would put a
    // flat run of textbook numbers in front of the first real one and read as a plateau.
    if (estimate.confidence === 'baja') continue

    out.push({
      weekIndex: i,
      lt1Bpm: estimate.lt1.bpm,
      lt2Bpm: estimate.lt2.bpm,
      lt1PaceSKm: estimate.lt1.paceSKm,
      lt2PaceSKm: estimate.lt2.paceSKm,
      basis: estimate.lt2.basis,
    })
  }

  return out
}

// ---------------------------------------------------------------------------
// Intensity distribution — the other half of the cardio picture
// ---------------------------------------------------------------------------

/**
 * The three-bucket reading of a week's intensity: easy, moderate, hard.
 *
 * Five zones is the right vocabulary for one session and the wrong one for a distribution
 * — the polarised-training question is not "how much Z3 against Z2" but "how much of the
 * week was genuinely easy", and five numbers is more than that question has. The split is
 * at the two thresholds this file estimates rather than at zone floors, which is what makes
 * it a physiological reading rather than an arithmetic one: below LT1 is easy, between the
 * two is the moderate domain that polarised training spends least time in, above LT2 is
 * hard.
 */
export interface Domains {
  easyS: number
  moderateS: number
  hardS: number
  totalS: number
  /** Share of recorded time under LT1, 0–1 — the number the 80/20 rule is about. */
  easyShare: number
}

export function domains(
  activities: Activity[],
  thresholds: Pick<Thresholds, 'lt1' | 'lt2'>,
): Domains {
  let easyS = 0
  let moderateS = 0
  let hardS = 0

  for (const activity of activities) {
    if (!isRun(activity.sportType) || activity.averageHeartrate == null) continue
    if (activity.averageHeartrate >= thresholds.lt2.bpm) hardS += activity.movingS
    else if (activity.averageHeartrate >= thresholds.lt1.bpm) moderateS += activity.movingS
    else easyS += activity.movingS
  }

  const totalS = easyS + moderateS + hardS
  return { easyS, moderateS, hardS, totalS, easyShare: totalS === 0 ? 0 : easyS / totalS }
}

/**
 * The same three-domain split, one row per block week — the intensity distribution as it
 * changes rather than as one total.
 *
 * The card above it already sums the whole block; what a total cannot show is the thing the
 * plan is actually checked against, which is whether the easy end erodes as the volume
 * climbs. Weeks with nothing recorded come back as an empty row rather than being skipped,
 * so the bars stay aligned with every other week axis on the screen.
 *
 * One estimate is used for every week, deliberately — the *current* one. Re-estimating the
 * thresholds week by week and splitting each week at its own pair would draw a chart whose
 * bars moved because the ruler moved, and the question here is about the training, not
 * about the estimate.
 */
export function domainsByWeek(
  block: BlockConfig,
  activities: Activity[],
  thresholds: Pick<Thresholds, 'lt1' | 'lt2'>,
  weeks: number,
): Domains[] {
  const byWeek: Activity[][] = Array.from({ length: weeks }, () => [])

  for (const activity of activities) {
    const week = Math.floor((startOfDay(activity.startedOn) - block.startsOn) / WEEK_MS)
    byWeek[week]?.push(activity)
  }

  return byWeek.map((week) => domains(week, thresholds))
}
