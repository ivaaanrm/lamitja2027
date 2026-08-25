# Plan week list

## Goal

Turn the 23 collapsible week cards on `/plan` into a compact, continuous list while
preserving the existing week summaries, disclosure behaviour, phase grouping and editing
tools. The current-week summary card above the list remains unchanged.

## Design

Each phase is one rounded `bg-fill` surface containing its heading and consecutive weeks.
The shared background is intentionally quieter than a card: it has no outer border or
shadow. Inside it, each week is a full-width list row separated by a fine rule, with no
individual surface, border or rounded corners. The row keeps its 56 px header, so the
disclosure control remains comfortably above the 44 px touch-target floor. The current week
continues to be identified explicitly by the mint `Ahora` label rather than by a card
outline.

Opening a row reveals the same sessions and week settings directly below its header, within
the same list item. The progress bar remains the rule between the summary and expanded
content for started weeks; otherwise a standard line separates those regions. Phase labels
sit inside their shared surfaces and continue to break the block into scannable groups.

The disclosure panel animates its intrinsic height and opacity on both opening and closing,
using the app's standard duration and iOS easing. Closed content remains mounted only until
the closing transition finishes, then leaves the DOM; this preserves a real closing motion
without paying to render every session in all 23 weeks. During that short closing interval
the panel is inert and hidden from assistive technology. The disclosure header transitions
to a visible mint focus treatment, and navigating to a newly opened week scrolls smoothly
unless the athlete has requested reduced motion.

The loading state uses the same subtle phase surface and divider-based rows so the page does
not briefly render individual card shapes before the data arrives. All existing data flow,
one-open-week state, automatic jump to the current week, edit actions and accessibility
attributes remain unchanged.

## Verification

- Run the unit test suite and production build.
- Confirm that week rows retain disclosure semantics and minimum touch sizes.
- Confirm that no `Card` surface is rendered around individual weeks or week skeletons, and
  that each phase has exactly one shared background.
- Confirm that opening, closing, focus and scroll transitions collapse under
  `prefers-reduced-motion`.
