# Plan week list

## Goal

Turn the 23 collapsible week cards on `/plan` into a compact, continuous list while
preserving the existing week summaries, disclosure behaviour, phase grouping and editing
tools. The current-week summary card above the list remains unchanged.

## Design

Each week is a full-width list row with a fine bottom divider. It has no raised surface,
outer border, shadow or rounded corners. The row keeps its 56 px header, so the disclosure
control remains comfortably above the 44 px touch-target floor. The current week continues
to be identified explicitly by the mint `Ahora` label rather than by a card outline.

Opening a row reveals the same sessions and week settings directly below its header, within
the same list item. The progress bar remains the rule between the summary and expanded
content for started weeks; otherwise a standard line separates those regions. Phase labels
continue to break the block into scannable groups.

The loading state uses the same divider-based rows so the page does not briefly render card
shapes before the data arrives. All existing data flow, one-open-week state, automatic jump
to the current week, edit actions and accessibility attributes remain unchanged.

## Verification

- Run the unit test suite and production build.
- Confirm that week rows retain disclosure semantics and minimum touch sizes.
- Confirm that no `Card` surface is rendered around individual weeks or week skeletons.
