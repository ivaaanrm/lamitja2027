# Dark vibrant palette

## Direction

Move the interface from soft charcoal and pastel accents to a darker, higher-energy
"night race" palette. The app should feel focused and athletic in low light: near-black
graphite grounds, crisp separation between layers, and saturated accents that read as
signals rather than decoration.

## Approaches considered

- **Balanced night race (selected):** darken all three surfaces and raise accent chroma
  while keeping each accent light enough for AA text contrast. This strengthens the app
  without making it glow.
- **Near-black neon:** pair black surfaces with maximum-chroma accents. This is bolder but
  too harsh for long training-plan and activity-detail screens.
- **Dark jewel tones:** use deep, restrained accents. This feels polished but does not
  answer the request for visibly more vibrant color.

## Token design

- Keep the existing `surface-deep`, `surface`, and `surface-raised` hierarchy, shifting
  each step darker while preserving a cool charcoal hue.
- Keep all eight accent names and their semantic mappings unchanged. Increase saturation
  and slightly lower perceived softness; mint remains the state and primary-action color.
- Leave typography, opacity-based fills, borders, layouts, shadows, and component classes
  unchanged. The change is centralized in `src/styles/global.css`.
- Require every solid accent to retain at least 4.5:1 contrast against both `surface` and
  `surface-raised`, because the same tokens are used for text as well as graphical marks.

## Verification

Calculate WCAG contrast for every accent against both application surfaces, run the test
suite and type checks, build the production Worker, and inspect representative screens at
a phone viewport if local data permits.
