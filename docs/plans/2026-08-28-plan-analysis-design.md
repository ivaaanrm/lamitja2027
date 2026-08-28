# Plan session analysis

## Goal

Add a compact sub-view to `/plan` where an athlete can inspect every prescribed session
across their block, answer questions such as “which weeks contain intervals?” and see the
total planned distance represented by the current filters.

The view analyses the written plan only. It does not mix in actual Strava distance or
unplanned activities; completion remains useful context elsewhere in the app, but the
numbers on this screen always mean prescribed work.

## Chosen shape

`/plan` gains a two-option control in its top navigation row, beside the athlete avatar.
The selector replaces the visible `Plan` heading, so the row names the two things the
screen can show instead of repeating the route name above them:

- **Semanas** keeps the existing phase-grouped accordion and editing flow unchanged.
- **Análisis** replaces that content with block-wide summaries, filters, and a compact
  session table.

The plan page omits `App.astro`'s ordinary title header and lets the existing Planner
island render this plan-specific navigation row. That keeps the selector and the content
in one state owner while leaving every other page header unchanged. Keeping both views in
the existing React island is preferable to a separate route: the
full athlete-scoped block is already loaded by `useBlock`, the switch is instant and works
offline, and there is no second navigation destination or API surface to maintain. A
server-filtered endpoint would add D1 queries for a dataset measured in dozens of rows and
would duplicate data already in memory.

## Data and calculations

The analysis flattens `WeekPlan.sessions` into rows carrying the matched session, its
one-based week number, week phase, and scheduled date. Rest entries are omitted because
they are calendar placeholders rather than training sessions. Strength and cross-training
remain valid rows even when their distance is blank.

Filters are applied in memory:

- session type;
- phase;
- minimum and maximum prescribed distance in kilometres;
- sort by plan order, longest first, or shortest first.

Blank distance bounds mean unbounded. Once either distance bound is set, sessions without
a prescribed distance do not match. The default order is week, date, and within-day order,
which recreates plan order exactly.

The summary is recalculated from the visible rows and reports:

- number of sessions;
- total prescribed kilometres;
- number of distinct weeks represented.

The derivation, filtering, sorting, and summary live in a pure browser-safe module so their
semantics can be pinned with unit tests and reused without importing React, Drizzle, or a
Worker binding.

## Interface

The analysis begins with the three-number summary, followed by a compact filter surface.
Type and phase use native selects for a small, reliable iPhone control. Distance uses two
numeric inputs (`Desde` and `Hasta`) and sorting uses another select. A clear action appears
only when a filter differs from the default.

The result is one responsive table-like grid:

- Larger screens show **Semana**, **Fecha**, **Tipo**, **Sesión**, and **Distancia** columns.
- On iPhone, each row becomes two scanning lines: week/date above; type, title, and distance
  below. There is no horizontal scrolling.
- Each non-rest row links to the existing `/sesion` detail with `desde=plan`, retaining the
  current edit and detail workflow.
- An empty filtered result explains that no sessions match and offers a one-tap reset.

The visual language stays deliberately analytical and compact: the existing raised card,
session type chips, tabular numbers, hairline row dividers, and 44px touch targets. It does
not introduce a dashboard aesthetic or another colour system.

## Scope and safety

No schema, migration, API, authentication, or persistence change is required. The only
input is the already athlete-scoped `/api/data` payload. Filter state is local to the
mounted view and resets on a new visit; it does not alter the plan.

## Verification

Unit tests cover rest exclusion, type and phase filters, open and bounded distance ranges,
all sort modes, and filtered totals. Existing unit tests, TypeScript checking, and the
Astro production build must still pass. The finished `/plan` view is inspected at an
iPhone-sized viewport and a desktop viewport, including empty and filtered states.
