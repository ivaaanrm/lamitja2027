-- Drops every table so `db:migrate` can rebuild the database from migrations/.
--
-- Used by `pnpm db:reset`, which runs this and then re-applies every migration. Nothing
-- here is precious: activities re-sync from Strava in one request, and the plan is the
-- only hand-written data — export it first if you care about it.
--
-- d1_migrations goes too, or the re-apply is a no-op.
PRAGMA defer_foreign_keys = true;
DROP TABLE IF EXISTS plan_sessions; -- references activities
DROP TABLE IF EXISTS plan_weeks;
DROP TABLE IF EXISTS activities;
DROP TABLE IF EXISTS app_state;
DROP TABLE IF EXISTS d1_migrations;
