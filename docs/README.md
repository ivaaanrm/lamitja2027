# lamitja2027 — Training Documentation

Analysis and planning for **La Mitja de Granollers, Sunday 24 January 2027**.
Goal: **sub-1:20:00** half marathon (3:47/km). Current PB: 1:23:33.

> Everything in this directory except [`setup.md`](setup.md) is **one athlete's own
> material** — his race data, his injury, his plan. It is here because it is the reasoning
> behind every default in the code, not because a fork is meant to keep it. A fork
> replaces `01`–`03` with its own, and either replaces `data/` with its own Strava exports
> or deletes it, at which point every comparison against last season reads as absent
> rather than as zero. See [`setup.md`](setup.md#d-making-it-your-race).

## Documents

| Doc | Covers |
|---|---|
| [Setup](setup.md) | How to run this app as your own: the Strava application, the Cloudflare deploy, the `.env`, local development, and the MCP server. The one document here that is not about this athlete. |
| [01 — La Mitja 2026 race & block analysis](01-lamitja-2026-race-analysis.md) | The Sep 2025 – Jan 2026 build that produced the 1:23:57 debut. Volume, workout structure, race execution, and what the data says was actually responsible for the result. |
| [02 — Injury & current state](02-injury-and-current-state.md) | The 7-month post-race collapse, the lateral knee injury (working hypothesis: ITBS), and where fitness sits as of 22 Aug 2026. |
| [03 — Training plan 2027](03-training-plan-2027.md) | The block itself: phase structure, volume targets, paces, checkpoints, knee protocol, downhill thread. Written as 22 weeks from 24 Aug and built as 23 from 17 Aug — §9 reconciles the two, and `src/lib/seed.ts` is this document typed out week by week. |
| [`plans/`](plans/) | Design notes for individual changes to the app — the logo, the palette, the dock, the plan screen. One file per decision, kept because they are the argument the code no longer shows. |

## Data

Raw Strava exports underpinning the analysis, read at build time by `src/lib/baseline.ts`
(which globs `data/*.csv` rather than naming files: `post-race` in a filename marks the
pre-block period, `build` marks the previous season, and a file named as neither is
ignored):

- [`data/2025-26-build-activities.csv`](data/2025-26-build-activities.csv) — 75 activities, 1 Sep 2025 → 18 Jan 2026
- [`data/2026-post-race-activities.csv`](data/2026-post-race-activities.csv) — 37 activities, 22 Jan 2026 → 20 Aug 2026

Columns: `date, name, sport, dist (m), time (s, moving), elev (m), re (relative effort)`.
Pulled from Strava athlete 56881786 on 22 Aug 2026.

## The one-line summary

The 1:23:33 was built on **34 km/week from a near-zero base in 20 weeks**, and the improvement came entirely from **aerobic endurance, not speed** — the 10K pace never moved, it was just held twice as long. Volume is the untapped lever for sub-1:20. The constraint is the knee and consistency, not talent.
