-- One-off teardown of the original 12-table schema.
--
-- The app was rescoped to a single athlete and the 22-week block starting 24 Aug 2026,
-- which replaced the multi-user tables (athletes, oauth_tokens), the sync machinery
-- (sync_jobs, sync_state, deletions) and the derived/plan tables with three:
-- activities, plan_sessions, app_state.
--
-- Nothing here holds data worth keeping: it was backfilled 2020-2026 history that is now
-- explicitly out of scope, and the analysis that needed it lives in docs/data/*.csv.
--
-- d1_migrations is dropped too so the new migrations/0000_init.sql applies cleanly —
-- the old migration happened to share that filename.
PRAGMA defer_foreign_keys = true;
DROP TABLE IF EXISTS deletions;
DROP TABLE IF EXISTS sync_jobs;
DROP TABLE IF EXISTS sync_state;
DROP TABLE IF EXISTS coach_briefs;
DROP TABLE IF EXISTS fitness_daily;
DROP TABLE IF EXISTS plan_sessions;
DROP TABLE IF EXISTS plan_weeks;
DROP TABLE IF EXISTS plans;
DROP TABLE IF EXISTS races;
DROP TABLE IF EXISTS laps;
DROP TABLE IF EXISTS activities;
DROP TABLE IF EXISTS oauth_tokens;
DROP TABLE IF EXISTS athletes;
DROP TABLE IF EXISTS app_state;
DROP TABLE IF EXISTS d1_migrations;
