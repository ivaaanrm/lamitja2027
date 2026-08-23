# La Mitja Granollers 2027 — Training Plan

**Target race:** La Mitja de Granollers, **Sunday 24 January 2027**
**A-goal:** **sub-1:20:00** (3:47/km)
**B-goal:** 1:21–1:22
**Block:** Monday 24 Aug 2026 → Sunday 24 Jan 2027 — **22 weeks**
**As built:** Monday 17 Aug 2026 → Sunday 24 Jan 2027 — **23 weeks** (see §9). Week numbers
below are this document's; the app counts W1–W23 from 17 Aug.
**The week:** four runs · one strength-only day · long run Sunday · Saturday empty (§2).
**Entered:** Tast de la Mitja 10K, Sat 31 Oct · Behobia–San Sebastián 20 km, Sun 8 Nov (§5).

> **Status: written.** Phase structure, volume targets and every week's sessions.
> The week-by-week plan lives in `src/lib/seed.ts` — this document is the design it
> encodes, and where the two disagree, this one is the intent and the code is the
> arithmetic. Re-seed from `/plan` after editing it.

---

## 1. The gap to close

| | Time | Pace |
|---|---|---|
| Current PB | 1:23:33 | 3:57/km |
| **Target** | **1:20:00** | **3:47/km** |
| Stretch | 1:19:00 | 3:44/km |

**Required improvement: 3:33 (4.2%).** Implies roughly a **36:15 standalone 10K**. Current best standalone 10K is 39:42 (Oct 2025); best 10K split is 37:41, set inside the half on a downhill section.

### Feasibility

**For:** 22 full weeks of runway. Proven fast responder — near-zero to 1:23:57 in 20 weeks. The PB was set on **34 km/week**, so the volume headroom is enormous and completely untapped.

**Against:** the knee (see [`02-injury-and-current-state.md`](02-injury-and-current-state.md)), and a consistency record of ten breaks of 6+ days in the last seven months.

**The binding constraints are the knee and consistency, not talent.** Decide between the A-goal and B-goal at the January checkpoint, not now.

## 2. The week

**Four runs, one strength-only day, two empty days.** That is the athlete's constraint,
not a preference the plan is free to negotiate with, and everything below is built around
it. The skeleton never moves, so a session that does is visible as a departure:

| | | |
|---|---|---|
| **Mon** | Hip strength, no running | 35 min |
| **Tue** | Quality 1 | intervals / threshold |
| **Wed** | Easy run — *medium-long* from the threshold phase on | 13–17 km |
| **Thu** | Empty | the bike's slot, if the knee asked for it |
| **Fri** | Quality 2, plus the second strength block | 20 min appended |
| **Sat** | Nothing | |
| **Sun** | **Long run** | |

Quality never lands on consecutive days (§6). Saturday stays empty so the Sunday long run
— the session this plan is actually built on — is never run on tired legs. The one Saturday
in the block with a number on it is the Tast, and that date belongs to the calendar.

The second strength session is **not** a sixth day: it rides on Friday's run, which puts
the two four days apart without ever asking for another trip out of the house.

### Phase structure

| Phase | Weeks | Dates | Volume | Focus |
|---|---|---|---|---|
| **0 · Rebuild & knee-proof** | 1–7 | 17 Aug – 4 Oct | 22 → 36 km | All easy, by feel. Strides from W3. Strength from day one. |
| **1 · Base & volume** | 8–13 | 5 Oct – 15 Nov | 38 → 50 km | 1 quality/wk. Long run 14 → 17 km, then the Behobia's 20. |
| **2 · Threshold** | 14–18 | 16 Nov – 20 Dec | 53 → **62 km peak** | 2 quality/wk. Tempo + long reps. Long run to 22 km. |
| **3 · Race-specific** | 19–21 | 21 Dec – 10 Jan | 60 → 48 km | Everything at 3:47/km. |
| **4 · Taper** | 22–23 | 11 – 24 Jan | 38 → race | Cut volume, keep sharpness. |

**≈935 km over 23 weeks — 41 km/wk average vs last block's 34**, peaking at 62 vs 46.

Down weeks at W4, W9, W13, W16, W21 (~75% volume) — indices 3, 8, 12, 15, 20.

> **Why 62 and not 68.** docs/03 was first written for six runs a week. The same 68 km over
> four days puts 17 km on the *average* run at the peak, which is a lot of single-session
> load for a knee that could not hold 3 km in April. What frequency gives up, length takes
> back: a 13–17 km medium-long run on Wednesday, and a long run that reaches 22.

> Sustaining 55+ km/wk matters more than touching 62 once.

## 3. The five changes vs the 2025-26 block

1. **Volume is the whole plan.** 34 → 41 km/wk average. This is where sub-1:20 comes from — the engine demonstrably responds to endurance work, not speed work.
2. **Length before intensity.** 3.6 → 4 runs/week, but the *average run* goes from 9.4 km to 11.7 km, and the longest from 21 km once to 22 km twice. Quality density drops from 33% of km to 20–25% and volume carries the load — on four days that means a medium-long midweek run, not a fifth easy shakeout.
3. **Strength, twice a week, non-negotiable.** One 17-minute session in the entire last block. With this knee history it is the highest-value addition available. Monday is a strength-only day; the second block rides on Friday's run rather than claiming a sixth day.
4. **Race-pace long runs.** None were run last block. Phase 3 is built around them.
5. **A real taper.** Last year: 42 km the week before the race and a four-day taper. This time, two weeks.

## 4. Training paces (goal-derived)

| Zone | Pace |
|---|---|
| Easy / recovery | 5:00–5:30/km |
| Long run | 4:45–5:10/km |
| Steady | 4:20–4:35/km |
| Threshold | 3:50–3:58/km |
| **Goal race pace** | **3:45–3:47/km** |
| 10K / VO2 | 3:30–3:40/km |

**In Phase 0, ignore all of these and run easy by feel.**

## 5. Checkpoints and the two dorsals

Two of these are real entries with real dates; the block is built around them rather than
the other way round.

| When | Test | Sub-1:20 marker |
|---|---|---|
| Sun 4 Oct (W7) | 10K time trial, solo — the Phase 0 gate | ~40:30, knee silent |
| **Sat 31 Oct (W11)** | **Tast de la Mitja 10K** — *entered* | ~38:30 |
| **Sun 8 Nov (W12)** | **Behobia–San Sebastián 20 km** — *entered, run as a long run* | no marker; see below |
| Sun 6 Dec (W16) | 10K race, flat and fast | ~37:00 |
| **Sun 10 Jan (W21)** | **10K — go/no-go** | **36:15–36:30 → go** |

The January checkpoint is the honest go/no-go. At 37:30 there, race for 1:21 — still a large PB.

### The Tast — Saturday 31 October

A test day, and the only Saturday in the block that is not empty, so **that week rests on
the Sunday instead**: four runs either way. It is run on La Mitja's own terrain, which makes
it the first course-specific read as well as the first honest fitness one.

### The Behobia — Sunday 8 November

**A dorsal, not a race.** Twenty kilometres at 4:45–5:10/km, run as that week's long run and
nothing more — which is why the seed types it `long` rather than `race`: nothing about it is
measured at race effort, and calling it a race would count all twenty kilometres as quality.

Two consequences the plan is shaped around:

- **It is eight days after the Tast.** W12 therefore carries no quality at all: a recovery
  jog Tuesday, a medium-long Wednesday, a shakeout Friday, the dorsal Sunday.
- **The descent from Gaintxurizketa to Errenteria is the best downhill rehearsal in the
  block, and the exact stimulus that broke the knee in January** (+192 m total, climbs at
  km 7 and km 16). High cadence, short stride, no braking. It is also the reason the long
  run reaches 17 km on 25 October rather than 14 — a 20 km race should be a step, not a leap.

The December 10K matters *more* because of this, not less: run easy, the Behobia reports
nothing about speed, and without it there is no fitness read between 31 October and January.

## 6. Knee protocol (ITBS)

### Primary intervention: cadence

Race cadence was 86.4 (≈173 spm); current is 80–83 (≈160–166). **Rebuilding to 85+ is simultaneously the injury fix and the race-form marker.** Raising cadence 5–10% shortens stride, cuts time in the compression zone, and lowers ITB strain rate — the best-evidenced ITBS intervention.

Use a metronome or music at 170–176 spm, starting on short runs. Track cadence every run; it is already in Strava.

### Strength — load the hip, don't stretch the band

The ITB cannot be lengthened; it is anchored to the femur, and foam-rolling it mostly just hurts. Twice weekly from week one, progressive load:

- Side planks with hip abduction
- Copenhagen planks
- Banded lateral walks
- Single-leg squats with strict pelvis control
- Single-leg RDLs

### Terrain rules

- **Flat only through Phase 0.**
- **No cambered roads.** Running the same side of a crowned road puts the downhill leg in adduction — direct provocation. Alternate sides, or use the track and flat paths.

### Test whether slow hurts more than fast

Many ITBS runners can run fast pain-free but not slow — longer ground contact, and a knee angle closer to the impingement window. **Test this deliberately in the first two weeks.** If it holds, easy runs become shorter and slightly quicker rather than long and plodding, which changes how Phases 0 and 1 are built.

### Progress by time-to-onset, not by feel

ITBS feels perfect right up until it doesn't. The honest metric in Phases 0–1 is not "did it hurt" but **"how far before anything showed up"** — and that number should climb every week.

### Traffic light

| Signal | Action |
|---|---|
| No pain | Go |
| Pain that warms up and vanishes | Proceed, but do not progress that week |
| Pain that worsens during, or next-morning stiffness | Stop. Cross-train. Reassess. |

### Cycling is the pressure valve

30 km rides were tolerated in February during the worst of the injury. **Thursday is its slot** — the empty day between the two quality sessions. It is deliberately *not* prescribed as a session: a valve opened every week by the calendar stops being a valve, and the athlete asked for five training days, not six. Ride it on the weeks the knee has said something, and as the automatic substitute for any run on a twinge day.

### General

- Never two hard days back-to-back.
- Never add volume and intensity in the same week.

## 7. Downhill thread — the course-specific risk

**The race that caused the injury has the worst possible profile for it.** First 10 km climbs +140 m; second 10 km gives it all back at −1 to −1.8%. Training 22 weeks on flat ground and then meeting 10 km of descent on tired legs rebuilds the exact conditions that broke the knee in January.

Downhill tolerance is therefore a **deliberate, progressive thread**:

| Phase | Downhill |
|---|---|
| **0** (W1–6) | Actively avoid. Flat only. |
| **1** (W7–12) | Reintroduce gently — short, shallow, controlled descents at the *end* of easy runs, when the hip is warm but not wrecked. |
| **2** (W13–17) | Build volume of gentle descent. Long runs on rolling terrain. |
| **3** (W18–20) | **Course-specific.** Run the actual second half of La Mitja. Race-pace segments on descent, on tired legs. |

This is also a performance lever, not just injury insurance: 3:08 was gained on the downhill half in January. Trained descending at 3:45/km is worth real time.

## 8. Phase 0 detail (W1–7, 17 Aug – 4 Oct)

- **Volume 22 → 36 km**, all easy, flat, four runs a week from week one
- **No pace bands at all.** §4 exists from W8 onward; Phase 0 is run by feel
- **Cadence work every run** — metronome at 170–176 spm
- **Hip strength 2×/week, non-negotiable**, from week 1
- **No intervals. No downhill. No long slow grinds.** Strides on flat ground from W3
- The long run is the instrument: 8 → 12 km, and the kilometre at which anything shows up is the number that has to climb

### Gate to Phase 1 — Sunday 4 October

A **10K time trial at ~40:30 with the knee silent**, plus two weeks with no
threshold-distance regression.

If the gate is not met, Phase 0 extends and Phase 1 compresses. There is room in the 23 —
sub-1:20 survives a two-week delay far better than it survives a March relapse. What does
*not* move is the Tast on 31 October: it becomes a training run rather than a test.

## 9. Where the written plan departs from this document

The block gained a week at the front — it starts Mon **17 Aug 2026**, not 24 Aug, so it is
**23 weeks**, and the extra week went to Phase 0. Four other deliberate departures:

| | This document | As written | Why |
|---|---|---|---|
| Rebuild volume | 22 → 36 km over 6 wk | 22 → 36 over 7 wk | 10.3%/wk breaches the 10% ramp cap |
| Down weeks | W4/8/12/16/20 | index 3/8/12/**15**/20 | the fourth cutback carries the December 10K: with four runs a week a race week has only two flexible runs left, and at 57 km those two would have to be 20 km each. A tune-up belongs in a cutback anyway. A cutback must never open a phase, which is what keeps index 7 clear |
| Long run peak | not stated | 22 km (W18, W20) | 35% of the peak week — the price of four days |
| Tast 10K | "W9–10, if it runs on its usual date" | **Sat 31 Oct (W11)** | confirmed entry. That week rests on the Sunday instead |
| Behobia 20 km | not in the document | **Sun 8 Nov (W12)**, typed `long` | confirmed entry, run as a long run at 4:45–5:10/km |
| Race week | 28 km | ~38 km | 28 including a 21.1 km race is seven kilometres over six days — a shutdown, not a taper |

**Checkpoints, as scheduled:** 10K time trial Sun 4 Oct (W7 gate) · **Tast de la Mitja
Sat 31 Oct (W11)** · **Behobia–San Sebastián Sun 8 Nov (W12)** · 10K control Sun 6 Dec (W16)
· 10K go/no-go Sun 10 Jan (W21) · La Mitja Sun 24 Jan (W23).

### What four days a week costs, honestly

Most sub-1:20 programmes are written for five or six days at 60–80 km/week, and the reason
is not dogma: at this level the aerobic ceiling is mostly a function of accumulated easy
volume. Four days caps that. Three things are doing the compensating, and they are all
evidenced rather than improvised:

- **Length replaces frequency.** The medium-long Wednesday run (13–17 km) is the single
  biggest structural difference from a six-day week — it is where the missing fifth run's
  kilometres go, in one block rather than two.
- **Quality density rises on purpose,** from ~15% in the base phase to 22–23% at the peak.
  Three of the four runs are structured. This is the FIRST/Furman finding — three quality
  runs a week plus cross-training matched five- and six-day plans in the half and the
  marathon, at measurably lower injury rates — and with this knee history the lower injury
  rate is not a side benefit, it is the point.
- **The bike stays available** on Thursday for the weeks that want aerobic load without
  another footstrike.

**The honest expectation:** this build gets to the January checkpoint with a real chance at
sub-1:20 and a better-than-even chance of 1:21. It is a smaller margin than the six-day
version had. It is also the version that survives seven months of ITBS, which the six-day
version might not have.

## 10. Open items

- [ ] Physio assessment to confirm ITBS and rule out lateral meniscus involvement
- [x] ~~Confirm the Tast date~~ — **Sat 31 Oct 2026**, entered
- [x] ~~Find a late-autumn 20K~~ — **Behobia–San Sebastián, Sun 8 Nov 2026**, entered
- [ ] Find the flat, fast December 10K for the W16 checkpoint (Sun 6 Dec)
- [ ] Find the 10K/15K for the W21 go/no-go (Sun 10 Jan)
- [ ] Behobia logistics: travel Saturday 7 Nov, so that day is rest by necessity as well as by rule
- [ ] Test slow-vs-fast pain response (first two weeks) — W1 and W2 Wednesdays are the test
- [ ] Re-cut Phases 1–2 if the W7 gate is missed: Phase 0 extends, Phase 1 compresses
