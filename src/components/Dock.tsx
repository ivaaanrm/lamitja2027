import { TABS, type Tab } from '@/lib/nav'
import { cn } from '@/lib/cn'

/**
 * The tab bar, iPhone-style: fixed to the bottom of the viewport, with an opaque underlay
 * across the full dock region so the page scrolling behind it never competes with its
 * labels, and sitting above the home indicator rather than under it.
 *
 * It used to be prerendered into every page, because the active tab was known at build
 * time — a prerendered document could only ever be one of them. It is not any more: the
 * four tabs are one document now (`src/components/router.tsx`), so which one is lit is a
 * prop, and the bar is the same four DOM nodes for the life of the app rather than four
 * that are thrown away and rebuilt on every tap.
 *
 * Each tab is a full-height 48px column: on a phone the target is the column, not the
 * glyph, and there is no hover state to lean on. 48 clears the 44px floor with room to
 * spare. That column, the 4px the bar insets it by and the home indicator under it are
 * `--dock-bar-h`, `--dock-inset` and `--dock-h` in `global.css` — `Shell.tsx` reserves the
 * room under a page from the same three values rather than from a number copied across.
 *
 * **It gets out of the way of the keyboard.** A fixed element is laid out against the
 * layout viewport, and the keyboard does not shrink the layout viewport — it covers it. So
 * a bar at `bottom: 0` sits behind the keyboard while iOS pans the visible part of the
 * page around underneath, and what that looks like is a dock wandering across the middle
 * of the screen every time a field is tapped. `src/lib/keyboard.ts` flags the document
 * root while the keyboard is up and the rule in `global.css` slides the bar out, which is
 * what a native tab bar does.
 *
 * **Two view-transition names, and they do opposite jobs.** `dock` lifts the whole bar out
 * of the root snapshot so it is *not* dragged through the page's cross-fade — a tab bar
 * that fades with the content is a bar that looks like part of the page — and `global.css`
 * then tells that pair not to animate at all, so the bar is swapped in place. `dock-active`
 * is the lit pill, which renders on exactly one tab, so across a hop the browser has the
 * same named box in two places and slides one into the other. The highlight is the one
 * thing that travels.
 *
 * The state is never carried by the pill alone: the active tab is also accent, its glyph is
 * drawn a quarter-step heavier, its label is semibold, and it is the one link with
 * `aria-current="page"`.
 *
 * One known consequence, so nobody spends an afternoon "fixing" it: for the length of the
 * transition the pill paints *over* the glyphs rather than behind them, because a captured
 * element is composited above the group it was lifted out of and nothing in the pseudo-tree
 * can be reordered without dropping it behind the page snapshot entirely. `fill-strong` is
 * ink at 12%, so what that costs is a barely-there lightening of one icon for a fifth of a
 * second while the pill is on the move.
 */

/**
 * Lucide, inlined and kept as a list of subpaths per glyph. Four icons is less markup than
 * any way of importing them, and it keeps the dock a single file with no dependency behind
 * it. `plan` draws a `<rect>` as well — the only glyph here that is not all strokes.
 */
const PATHS: Record<Tab, readonly string[]> = {
  today: ['m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M9 22V12h6v10'],
  plan: ['M3 10h18M8 2v4M16 2v4'],
  progress: ['M16 7h6v6', 'm22 7-8.5 8.5-5-5L2 17'],
  log: ['M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01'],
}

export function Dock({ tab }: { tab: Tab }) {
  return (
    <nav
      id="dock"
      aria-label="Secciones"
      style={{ viewTransitionName: 'dock' }}
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 bg-surface-deep px-gutter pb-[var(--dock-inset)]"
    >
      <ul className="performance-shadow pointer-events-auto mx-auto flex max-w-md gap-0.5 rounded-2xl border border-line bg-surface-deep p-1">
        {TABS.map((entry) => {
          const active = entry.key === tab
          return (
            <li key={entry.key} className="flex-1">
              <a
                href={entry.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  // `isolate` + `-z-10` keeps the pill behind the glyph without needing the
                  // glyph and the label to be positioned as well: the link becomes its own
                  // stacking context, so the negative layer cannot escape it.
                  'tappable isolate relative flex h-12 flex-col items-center justify-center gap-0.5 rounded-xl',
                  active ? 'text-accent' : 'text-label-3 active:bg-fill',
                )}
              >
                {active ? (
                  <span
                    style={{ viewTransitionName: 'dock-active' }}
                    aria-hidden="true"
                    className="absolute inset-0 -z-10 rounded-xl bg-fill-strong"
                  />
                ) : null}
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={active ? 2.25 : 1.75}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="size-5"
                >
                  {entry.key === 'plan' ? <rect width="18" height="18" x="3" y="4" rx="2" /> : null}
                  {PATHS[entry.key].map((d) => (
                    <path key={d} d={d} />
                  ))}
                </svg>
                <span className={cn('text-caption2 leading-none', active && 'font-semibold')}>
                  {entry.label}
                </span>
              </a>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
