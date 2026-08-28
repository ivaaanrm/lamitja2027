# Strava-orange accent

## Goal

Replace the app's mint primary/state accent with Strava orange so navigation, actions,
focus, current state and positive completion all speak one color language.

## Token design

Add `--color-accent: #fc4c02`, using the exact orange already used by the two Strava
connection buttons. State and primary utilities move from `mint` to `accent` rather than
changing the value of the mint token in place.

Mint remains a palette color for the cross-training session type. This keeps session-type
encoding separate from application state and prevents a brand change from silently
recoloring one workout category.

## Scope

The accent token owns:

- selected navigation and current-day/week markers;
- primary buttons, links, focus rings and text selection;
- completed/good states and progress completion;
- primary chart strokes and current-period highlights;
- countdown markers, launch progress and saved-state feedback.

Session-type colors, amber warnings, red failures and neutral labels do not change. The
Strava connection buttons use `bg-accent` so the orange has one source of truth rather than
two repeated literals.

## Verification

Run the full test suite, CI type check and production build. Search source and generated
CSS to confirm `accent` resolves to `#fc4c02`, no state UI still uses mint, and mint remains
only in the cross-training color mapping and its token.
