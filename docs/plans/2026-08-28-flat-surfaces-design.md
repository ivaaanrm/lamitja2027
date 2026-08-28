# Flat content surfaces

## Goal

Make every content view use the same quiet surface language as the plan's week groups and
the home-screen countdown: one translucent `bg-fill` plane, rounded corners, no outline and
no raised shadow.

## Boundary

The shared `Card` primitive becomes the source of truth. That change reaches dashboard,
plan, progress, training log, settings, session detail, activity detail, empty, loading and
error content across the application in one place.

Three standalone form panels do not use `Card` and receive the same treatment directly:
login, registration and onboarding. They are content surfaces even though their forms live
outside the shared card component.

Surfaces whose background communicates a different role stay unchanged:

- the dock is persistent navigation;
- the session editor is an elevated modal sheet;
- inputs are recessed wells;
- session rows and type chips encode hierarchy or training type;
- boot, login and error-page mark tiles frame the identity mark rather than page content;
- warning, success and selected-control fills communicate state.

This boundary avoids turning “make content cards consistent” into “remove every layer from
the interface.”

## Implementation

`Card` drops `performance-shadow`, `border border-line` and `bg-surface-raised`, replacing
them with `bg-fill`. Its radius and compact padding remain unchanged. Callers may still
override the fill for a semantic reason through `className`.

The standalone form panels make the same class replacement. Analysis-specific surface
overrides are removed once the primitive provides the desired appearance.

Hairlines inside repeated data remain: stat-column rules, week dividers and session-row
dividers separate adjacent records. The removed line is the outline around a whole content
component.

## Verification

Run the full unit suite, CI type check and production build. Confirm generated CSS includes
the flat fill and that ordinary `Card` markup no longer emits the raised surface, outline or
performance shadow classes.
