import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * The two shapes every trend on these pages is drawn with, hand-rolled in SVG and flexbox.
 *
 * A charting library was the obvious alternative and it loses on every axis that matters
 * here: Recharts is ~100 KB into a PWA that is otherwise a few tens, it renders its own
 * text at its own sizes, and none of these charts want a tooltip — on a phone the number
 * is on the card above the chart, not behind a hover. What is left is a polyline and a
 * row of divs, which is what this is.
 *
 * Colour is passed in as Tailwind classes rather than as hex, so a series is styled the
 * same way as everything else on the page and dark-mode tokens stay in one system.
 *
 * Seven shapes come out of here and there is no eighth: `LineChart` for a trend over an
 * axis, `Sparkline` for a trace with no axis at all, `BarRow` for a week-by-week
 * comparison, `SplitBars` for a run quantised into its own kilometres or laps,
 * `StackedBar` for shares of a whole, `ChartScale` for the caption that says what any of
 * their axes mean, and `ChartLegend` for the key naming their series. The legend was the
 * sixth all along — it was just hand-rolled twice outside this file, in two different
 * shapes, which is exactly what the "no sixth" rule existed to prevent.
 *
 * None of them takes a tooltip and none of them ever will — the number is on the card
 * above the chart, and a phone has no hover to put one behind. Which is also why every one
 * of them takes a Spanish `label`: with no hover there is no second way in, so the reading
 * has to be in the accessibility tree or it is nowhere.
 */

/** The plotted box, in viewBox units. Rendered at `w-full`, so these are aspect ratios. */
const WIDTH = 360

export interface Series {
  /** One value per x step. `null` breaks the line — a season that had not started yet. */
  values: (number | null)[]
  /** Tailwind `stroke-*`. */
  className: string
  /** Tailwind `fill-*` for the area beneath, when the line is the page's subject. */
  areaClassName?: string
  dashed?: boolean
  strokeWidth?: number
  /** Draw one small marker per value. Useful for short weekly histories. */
  points?: boolean
  /** Tailwind `stroke-*` for those markers — they are drawn as strokes, see `Dot`. */
  pointClassName?: string
  /** The halo that lifts a marker off the line under it. Match the card's ground. */
  pointHaloClassName?: string
}

interface Marker {
  /** Index on the x axis. */
  at: number
  className?: string
  label?: string
}

/**
 * A multi-series line over a shared x axis of `steps` points.
 *
 * Every series is indexed, not dated: the caller has already put both seasons on the same
 * axis, which is the only way the comparison is honest. Nulls are gaps rather than zeroes.
 */
export function LineChart({
  series,
  steps,
  height = 120,
  yMax: yMaxInput,
  yMin: yMinInput = 0,
  invert = false,
  markers = [],
  rules = [],
  backdrop,
  shadeFrom,
  baseline = false,
  reveal = true,
  className,
  label,
}: {
  series: Series[]
  steps: number
  height?: number
  yMax?: number
  /** Floor of the axis. Zero for anything that is a quantity; a trace such as heart rate
   *  or altitude wants the floor just under its lowest point, or it is a flat line. */
  yMin?: number
  /** Smaller is higher — pace, where fast is up. */
  invert?: boolean
  markers?: Marker[]
  /** Horizontal references in y units — a zone floor, a cadence target, a goal pace. */
  rules?: { at: number; className?: string }[]
  /**
   * A profile drawn faintly behind the series on its own scale — the terrain under a
   * pace trace. It shares the x axis and nothing else, so it never moves the y range.
   */
  backdrop?: (number | null)[]
  /** Index from which the axis is the future — drawn as a dimmed band. */
  shadeFrom?: number
  /**
   * A hairline along the floor of the plot.
   *
   * The only axis this chart ever draws. A full grid is a desktop affordance — it buys
   * precision nobody is reading off a 96px-tall plot on a phone, and it competes with the
   * one line the card is about. A floor is different: it tells the eye where zero is, so
   * a curve that dips towards it reads as *falling* rather than as merely low. Leave it
   * off for a trace whose `yMin` is not a meaningful zero (heart rate, altitude) — a
   * baseline under an arbitrary floor is a line pretending to be information.
   */
  baseline?: boolean
  /**
   * Draw the lines on rather than having them simply be there. On mount only: the paths
   * are keyed, so React reuses them across data changes and the animation does not
   * restart every time `/api/data` revalidates behind the screen.
   *
   * Dashed series are excluded whatever this says — the reveal owns `stroke-dasharray`,
   * and a series cannot be drawn on *and* be a dashed line at the same time.
   */
  reveal?: boolean
  className?: string
  /** Read by screen readers in place of the plot. */
  label: string
}) {
  const values = series.flatMap((s) => s.values).filter((v): v is number => v != null)
  const yMin = Math.min(yMinInput, ...values)
  const yMax = Math.max(yMaxInput ?? 0, ...values, yMin + 1)
  const x = (i: number) => (steps <= 1 ? WIDTH / 2 : (i / (steps - 1)) * WIDTH)
  const y = (v: number) => {
    const share = (v - yMin) / (yMax - yMin)
    return invert ? share * height : height - share * height
  }

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      className={cn('h-auto w-full overflow-visible', className)}
      style={{ aspectRatio: `${WIDTH} / ${height}` }}
    >
      {shadeFrom != null && shadeFrom < steps - 1 ? (
        <rect
          x={x(shadeFrom)}
          y={0}
          width={WIDTH - x(shadeFrom)}
          height={height}
          className="fill-ink/[0.03]"
        />
      ) : null}

      {backdrop ? <Backdrop values={backdrop} x={x} height={height} /> : null}

      {baseline ? (
        <line
          x1={0}
          x2={WIDTH}
          y1={Math.min(height - 0.5, Math.max(0.5, y(yMin)))}
          y2={Math.min(height - 0.5, Math.max(0.5, y(yMin)))}
          vectorEffect="non-scaling-stroke"
          className="stroke-line"
        />
      ) : null}

      {markers.map((marker, i) => (
        <line
          key={i}
          x1={x(marker.at)}
          x2={x(marker.at)}
          y1={0}
          y2={height}
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
          className={cn('stroke-line-strong', marker.className)}
        >
          {/* The marker's name is spoken, never drawn. `preserveAspectRatio="none"`
              stretches every glyph inside this viewBox along with the geometry, so an
              SVG `<text>` here would render at a different width on every screen size —
              the caption belongs outside the plot, in `ChartScale`. */}
          {marker.label ? <title>{marker.label}</title> : null}
        </line>
      ))}

      {rules
        .filter((rule) => rule.at >= yMin && rule.at <= yMax)
        .map((rule, i) => (
          <line
            key={i}
            x1={0}
            x2={WIDTH}
            y1={y(rule.at)}
            y2={y(rule.at)}
            strokeDasharray="3 3"
            vectorEffect="non-scaling-stroke"
            className={cn('stroke-line-strong', rule.className)}
          />
        ))}

      {series.map((s, i) => {
        // The reveal owns the dash pattern, so a dashed series opts out of it rather than
        // losing its dashes. `pathLength` goes on only when it is animating, for the same
        // reason: it renormalises `stroke-dasharray`, and `4 4` against a path one unit
        // long is a dash four times the line — a solid stroke wearing a dash's clothes.
        const drawn = reveal && !s.dashed
        return (
          <g key={i}>
            {s.areaClassName
              ? segments(s.values).map((segment, j) => (
                  <path
                    key={j}
                    d={areaPath(segment, x, y, height)}
                    className={cn('stroke-none', reveal && 'fade-in', s.areaClassName)}
                  />
                ))
              : null}
            {segments(s.values).map((segment, j) => (
              <path
                key={j}
                d={linePath(segment, x, y)}
                fill="none"
                strokeWidth={s.strokeWidth ?? 2}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray={s.dashed ? '4 4' : undefined}
                pathLength={drawn ? 1 : undefined}
                vectorEffect="non-scaling-stroke"
                className={cn(drawn && 'chart-draw', s.className)}
              />
            ))}
            {s.points
              ? s.values.map((value, pointIndex) =>
                  value == null ? null : (
                    <Dot
                      key={`point-${pointIndex}`}
                      cx={x(pointIndex)}
                      cy={y(value)}
                      className={s.pointClassName ?? 'stroke-label'}
                      haloClassName={s.pointHaloClassName}
                    />
                  ),
                )
              : null}
          </g>
        )
      })}
    </svg>
  )
}

/**
 * A point marker that survives a stretched viewBox.
 *
 * This was a `<circle r="3">` and it was rendering as an *ellipse*. `preserveAspectRatio
 * ="none"` is what lets the plot fill whatever box the card gives it, and the moment that
 * box is not exactly `WIDTH × height` the x and y scale factors differ — every shape in
 * the viewBox is stretched with them. The paths above are protected by
 * `vectorEffect="non-scaling-stroke"`, but that only ever protected their *stroke width*;
 * a circle's roundness is geometry, and geometry is precisely what got stretched. The
 * further the render width drifts from 360, the more egg-shaped the markers got.
 *
 * So the marker is not a shape. It is a zero-length stroke with a round cap: the cap is
 * generated in device space after the transform, which makes it a true circle exactly
 * `strokeWidth` pixels across no matter what the viewBox is doing underneath. The line has
 * a hundredth of a unit of length rather than none, because a genuinely empty subpath is
 * the one case renderers still disagree about — the same trick `linePath` already uses to
 * make a one-point series visible.
 *
 * The halo is a second, fatter cap in the card's own ground colour, drawn first: without
 * it a marker sitting on its own line is a bump rather than a point.
 */
function Dot({
  cx,
  cy,
  className,
  haloClassName = 'stroke-surface-raised',
  size = 5,
}: {
  cx: number
  cy: number
  /** Tailwind `stroke-*`. A `fill-*` here is inert — the path encloses no area. */
  className: string
  haloClassName?: string
  /** Rendered px across, since the cap ignores the viewBox scale. */
  size?: number
}) {
  const d = `M${cx.toFixed(2)} ${cy.toFixed(2)}L${(cx + 0.01).toFixed(2)} ${cy.toFixed(2)}`
  return (
    <>
      <path
        d={d}
        fill="none"
        strokeWidth={size + 3}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        className={haloClassName}
      />
      <path
        d={d}
        fill="none"
        strokeWidth={size}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        className={className}
      />
    </>
  )
}

/** The backdrop, scaled to its own range and pressed into the lower 60% of the plot so it
 *  reads as ground beneath the line rather than as a second series. */
function Backdrop({
  values,
  x,
  height,
}: {
  values: (number | null)[]
  x: (i: number) => number
  height: number
}) {
  const present = values.filter((v): v is number => v != null)
  if (present.length < 2) return null
  const lo = Math.min(...present)
  const span = Math.max(1, Math.max(...present) - lo)
  const y = (v: number) => height - ((v - lo) / span) * height * 0.6
  return (
    <g>
      {segments(values).map((segment, j) => (
        <path key={j} d={areaPath(segment, x, y, height)} className="fill-ink/[0.06] stroke-none" />
      ))}
    </g>
  )
}

/** Runs of consecutive non-null points, each carrying its own index on the axis. */
function segments(values: (number | null)[]): { i: number; v: number }[][] {
  const out: { i: number; v: number }[][] = []
  let run: { i: number; v: number }[] = []
  for (const [i, v] of values.entries()) {
    if (v == null) {
      if (run.length) out.push(run)
      run = []
    } else {
      run.push({ i, v })
    }
  }
  if (run.length) out.push(run)
  return out
}

const linePath = (
  points: { i: number; v: number }[],
  x: (i: number) => number,
  y: (v: number) => number,
) =>
  points
    // A one-point segment gets a dot's worth of line, or it would not draw at all.
    .map((p, j) => `${j === 0 ? 'M' : 'L'}${x(p.i).toFixed(2)} ${y(p.v).toFixed(2)}`)
    .join(' ') + (points.length === 1 ? ` L${(x(points[0]!.i) + 0.01).toFixed(2)} ${y(points[0]!.v).toFixed(2)}` : '')

const areaPath = (
  points: { i: number; v: number }[],
  x: (i: number) => number,
  y: (v: number) => number,
  height: number,
) =>
  `${linePath(points, x, y)} L${x(points.at(-1)!.i).toFixed(2)} ${height} L${x(points[0]!.i).toFixed(2)} ${height} Z`

export interface Bar {
  /** What was run. */
  value: number
  /** Last season at the same distance from race day — `null` where it has no counterpart. */
  ghost?: number | null
  /** What the plan asked for, drawn as a rule across the bar. */
  target?: number | null
  className?: string
  key: string | number
  title?: string
}

/**
 * A row of weekly bars, with last season behind each one and the plan's target across it.
 *
 * Divs rather than SVG: the bars are the width of a finger and the eye reads them as a
 * shape, so crisp 1px edges at any device pixel ratio matter more than anything a path
 * would buy.
 *
 * Three layers stack in one 15px-wide column, and the order they are drawn in is the
 * whole design:
 *
 *   The **ghost** is the full width of the slot and sits at the back. It used to be the
 *   same width as the bar in front of it, which meant it was legible only on the weeks it
 *   was *taller* — every week where this season beat last season simply lost its
 *   comparison. A full-width slab behind an inset bar always reads, in both directions.
 *
 *   The **bar** is inset to 60% of the slot, but only when there is a ghost to sit in
 *   front of. A row with no comparison keeps its full-width bars: narrowing them to make
 *   room for nothing would just make the chart quieter for no reading.
 *
 *   The **target rule** spans the whole slot, so it is read against the ghost's width and
 *   not against the bar's. `peak` already includes every target, so the rule can never
 *   land above the plot — and a target of zero is not drawn at all, because a dashed line
 *   sitting on the floor is a rule that says nothing and looks like an axis.
 */
export function BarRow({
  bars,
  label,
  height = 72,
  className,
}: {
  bars: Bar[]
  /**
   * Spanish, and required for the same reason `LineChart`'s is: the per-bar `title` below
   * is a desktop bonus and nothing else — a phone has no hover, and iOS shows nothing on a
   * long press — so without this the densest chart on the page reads as nothing at all.
   * One sentence for the row, the way `WeekCalendar` labels a column.
   */
  label: string
  height?: number
  className?: string
}) {
  const peak = Math.max(
    1,
    ...bars.flatMap((b) => [b.value, b.ghost ?? 0, b.target ?? 0]),
  )
  const pct = (value: number) => `${Math.min(100, Math.max(0, (value / peak) * 100))}%`
  const compared = bars.some((b) => b.ghost != null && b.ghost > 0)

  return (
    <div
      role="img"
      aria-label={label}
      className={cn('flex items-end gap-px', className)}
      style={{ height }}
    >
      {bars.map((bar) => (
        <div
          key={bar.key}
          className="relative flex h-full flex-1 items-end justify-center"
          title={bar.title}
        >
          {bar.ghost != null && bar.ghost > 0 ? (
            <span
              aria-hidden
              className="absolute inset-x-0 bottom-0 rounded-t-[2px] bg-ink/12"
              style={{ height: pct(bar.ghost) }}
            />
          ) : null}
          <span
            className={cn(
              'relative rounded-t-[2px]',
              compared ? 'w-3/5' : 'w-full',
              bar.className ?? 'bg-label-3',
            )}
            style={{ height: pct(bar.value) }}
          />
          {bar.target != null && bar.target > 0 ? (
            <span
              aria-hidden
              className="absolute inset-x-0 border-t border-dashed border-line-strong"
              style={{ bottom: pct(bar.target) }}
            />
          ) : null}
        </div>
      ))}
    </div>
  )
}

/**
 * A single bar split by share — the five zones, or anything else that adds to a whole.
 *
 * At a total of zero this used to `return null`, which is an empty state nobody wrote:
 * the card lost a row of height and said nothing about why. The component now always
 * draws its track, so the shape of the answer is there whether or not there is an answer
 * yet, and it takes the sentence that explains the gap.
 *
 * The sentence stays the caller's, because only the caller knows *why* it is empty —
 * "aún no hay ninguna salida con pulso" and "esta semana todavía no has corrido" are the
 * same zero and completely different information. The default is deliberately bland so
 * that leaving it at the default reads as unfinished.
 */
export function StackedBar({
  parts,
  label,
  emptyLabel = 'Sin datos todavía.',
  className,
}: {
  parts: { value: number; className: string; key: string | number }[]
  /**
   * Spanish, and required: the shares are drawn as widths of colour and nothing else, so
   * this is the only reading anyone who cannot see the bar ever gets. Where the card lists
   * the same shares underneath, say so here rather than repeating the numbers.
   */
  label: string
  /** Spanish, one sentence, and specific about what is missing. */
  emptyLabel?: string
  className?: string
}) {
  const total = parts.reduce((sum, p) => sum + p.value, 0)

  if (total <= 0)
    return (
      <div className={className}>
        <div aria-hidden className="h-2.5 rounded-full bg-fill" />
        <p className="mt-1.5 text-caption2 text-label-3">{emptyLabel}</p>
      </div>
    )

  return (
    <div
      role="img"
      aria-label={label}
      className={cn('flex h-2.5 overflow-hidden rounded-full bg-fill', className)}
    >
      {parts.map((part) => (
        <span
          key={part.key}
          className={part.className}
          style={{ width: `${(part.value / total) * 100}%` }}
        />
      ))}
    </div>
  )
}

/**
 * A bare trace: no axis, no markers, no scale — the shape of a number's recent history and
 * nothing else.
 *
 * This is the "soft waveform" the art direction allows as decoration, and the condition on
 * it is that it is not decoration: a pace trace in a running app is the app's own
 * signature, and it earns its place here by being made of real values. A sparkline with
 * made-up data, or one drawn because a card looked empty, is the thing that rule exists to
 * forbid.
 *
 * Sized by its `width`/`height` *attributes* rather than by `w-full`, which is what makes
 * it safe in `HeroMetric`'s trailing slot: an intrinsically-sized SVG scales its viewBox
 * uniformly, so the end dot is a circle and the stroke is the weight it was asked for.
 * Anything wider than about 120px is not a sparkline any more, it is a chart, and
 * `LineChart` is the component for that.
 */
export function Sparkline({
  values,
  width = 96,
  height = 28,
  className = 'stroke-mint',
  areaClassName,
  dot = true,
  dotClassName,
  reveal = true,
  label,
}: {
  /** `null` breaks the trace, the same as in `LineChart`. */
  values: (number | null)[]
  width?: number
  height?: number
  /** Tailwind `stroke-*`. */
  className?: string
  /** Tailwind `fill-*` for a filled trace. Keep it under 12% or it stops being a trace. */
  areaClassName?: string
  /** A marker on the last value — where the number on the card is. */
  dot?: boolean
  dotClassName?: string
  reveal?: boolean
  /** Spanish. Omit only when the card's own heading already says what this traces. */
  label?: string
}) {
  const present = values.filter((v): v is number => v != null)
  if (present.length < 2) return null

  const lo = Math.min(...present)
  const span = Math.max(1e-6, Math.max(...present) - lo)
  // 2px of headroom top and bottom, so a peak's round cap is not clipped by the viewBox.
  const x = (i: number) => (values.length <= 1 ? width / 2 : (i / (values.length - 1)) * width)
  const y = (v: number) => height - 2 - ((v - lo) / span) * (height - 4)

  const last = values.reduce<{ i: number; v: number } | null>(
    (found, v, i) => (v == null ? found : { i, v }),
    null,
  )

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role={label ? 'img' : 'presentation'}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className="overflow-visible"
    >
      {areaClassName
        ? segments(values).map((segment, j) => (
            <path
              key={j}
              d={areaPath(segment, x, y, height)}
              className={cn('stroke-none', reveal && 'fade-in', areaClassName)}
            />
          ))
        : null}
      {segments(values).map((segment, j) => (
        <path
          key={j}
          d={linePath(segment, x, y)}
          fill="none"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          pathLength={reveal ? 1 : undefined}
          vectorEffect="non-scaling-stroke"
          className={cn(reveal && 'chart-draw', className)}
        />
      ))}
      {dot && last ? (
        <Dot cx={x(last.i)} cy={y(last.v)} className={dotClassName ?? className} size={4} />
      ) : null}
    </svg>
  )
}

/**
 * The caption under a plot: where the axis starts, what it is measuring, where it ends.
 *
 * It is HTML, deliberately, and it is the reason `LineChart` draws no text of its own.
 * That chart stretches its viewBox to whatever box the card gives it, so a `<text>` inside
 * it would render at a different width on every screen — and even scaled correctly, SVG
 * text does not inherit the type ramp, the tabular figures or the Spanish decimal comma
 * that every other number on the page goes through.
 *
 * Three slots, and the middle one is the label rather than a value: the ends of the axis
 * are where the eye checks the range, and the centre is where it checks what it is
 * looking at. Anything more than three is a legend, and a legend belongs under the chart
 * as its own row.
 */
export function ChartScale({
  start,
  end,
  children,
  className,
}: {
  /** The left end of the axis — `S1`, the first date. */
  start?: React.ReactNode
  /** The right end — `S23`, today. */
  end?: React.ReactNode
  /** What the axis measures, in Spanish: `km por semana`, `discontinua = objetivo`. */
  children?: React.ReactNode
  className?: string
}) {
  return (
    <figcaption
      // `label-3`, not `label-4`: the ends of an axis and the key in the middle are data —
      // `S1`, `24 ene`, `12,4 km`, `Forma` — and `label-4` is the one step that misses AA,
      // so nothing but chrome may wear it.
      className={cn(
        'mt-2 flex items-baseline justify-between gap-2 text-caption2 tabular-nums text-label-3',
        className,
      )}
    >
      <span>{start}</span>
      {children ? <span className="truncate text-center">{children}</span> : null}
      <span>{end}</span>
    </figcaption>
  )
}

/**
 * A chart's key: which colour is which series.
 *
 * Two shapes, and which one to use is not a taste: a `line` key names a stroke on a plot,
 * a `dot` key names a mark on a grid, and a key drawn as the wrong one makes the reader
 * hunt for ink that is not there.
 *
 * `dense` is the version that rides inside `ChartScale`'s middle slot. That slot truncates
 * rather than wraps — it shares one row with both ends of the axis — so a dense key is a
 * nowrap row of at most two entries; a third belongs in the prose under the card. Without
 * `dense` the key is its own wrapping row beneath the chart, which is where a grid with
 * nine session colours has to put it.
 */
export function ChartLegend({
  items,
  dense = false,
  className,
}: {
  /** `className` is the Tailwind `bg-*` of the series it names. */
  items: { label: string; className: string; shape?: 'line' | 'dot' }[]
  dense?: boolean
  className?: string
}) {
  return (
    <span
      className={cn(
        'flex items-center',
        dense
          ? 'justify-center gap-x-2 whitespace-nowrap'
          : 'flex-wrap gap-x-2 gap-y-1 text-caption2 text-label-3',
        className,
      )}
    >
      {items.map((item) => (
        <span key={item.label} className="flex items-center gap-1">
          <span
            aria-hidden
            className={cn(
              'shrink-0',
              item.shape === 'dot' ? 'size-2 rounded-full' : 'h-[3px] w-3 rounded-full',
              item.className,
            )}
          />
          {item.label}
        </span>
      ))}
    </span>
  )
}

export interface SplitBar {
  key: string | number
  /** What the bar is tall for, in a unit where **bigger is taller**. Speed, not pace. */
  value: number
  /** Tailwind `bg-*`. Defaults to the neutral fill. */
  className?: string
  /** Spoken on hover, and the only place a per-bar number lives — the table says the rest. */
  title?: string
}

/**
 * A run quantised into its own kilometres, or into the laps the athlete pressed for, with
 * the climb it was run over showing through behind.
 *
 * This sits above the split table rather than replacing it. The table answers "what was
 * the fourth kilometre" and answers it exactly; it is very bad at "was the second half
 * slower than the first", which is a question about shape and which twelve numbers in a
 * column cannot be read for. So the bars carry no labels of their own — every number they
 * could print is already printed underneath them, and printing it twice at 375px is how a
 * compact card becomes a busy one.
 *
 * The altitude behind is the same profile the trace draws, on the same distance axis and
 * its own y scale. It is there because the honest answer to "why was kilometre 7 slow" is
 * usually the hill under it, and putting the two in one box is what lets the eye make that
 * connection without being told.
 *
 * **The scale does not start at zero, and that is deliberate.** The spread between a fast
 * and a slow kilometre on an easy run is a few percent; zero-based bars would render
 * twelve identical rectangles and answer nothing. The axis runs from a little under the
 * slowest split to the fastest, which is what makes the difference legible — and it is why
 * `FLOOR` is not 0: the slowest split still gets a quarter of the height, so it reads as
 * "slowest" rather than as "missing". A caller owes the reader that range in words.
 */
const FLOOR = 0.25

export function SplitBars({
  bars,
  backdrop,
  height = 56,
  label,
  className,
}: {
  bars: SplitBar[]
  /** The altitude profile over the same distance axis, on its own scale. */
  backdrop?: (number | null)[]
  height?: number
  /** Read by screen readers in place of the bars. */
  label: string
  className?: string
}) {
  const values = bars.filter((b) => b.value > 0).map((b) => b.value)
  if (values.length === 0) return null
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  // One split, or twelve identical ones: every bar is the fastest, so every bar is full.
  const share = (value: number) => (hi === lo ? 1 : FLOOR + (1 - FLOOR) * ((value - lo) / (hi - lo)))

  return (
    <div
      role="img"
      aria-label={label}
      className={cn('relative overflow-hidden rounded-md', className)}
      style={{ height }}
    >
      {backdrop ? <SplitBackdrop values={backdrop} height={height} /> : null}

      {/* `gap-px` rather than a real gap: at thirteen kilometres across a 375px phone each
          column is under 30px, and anything wider than a hairline between them is spent on
          the space instead of on the bar. */}
      <div className="relative flex h-full items-end gap-px">
        {bars.map((bar) => (
          <div key={bar.key} className="flex h-full flex-1 items-end" title={bar.title}>
            {bar.value > 0 ? (
              <span
                className={cn('w-full rounded-t-[2px]', bar.className ?? 'bg-label-3')}
                style={{ height: `${share(bar.value) * 100}%` }}
              />
            ) : null}
          </div>
        ))}
      </div>
    </div>
  )
}

/** The climb under the bars, on its own scale and pressed into the lower half so the bars
 *  stay the subject. Same shape as `LineChart`'s backdrop, drawn to its own box. */
function SplitBackdrop({ values, height }: { values: (number | null)[]; height: number }) {
  const present = values.filter((v): v is number => v != null)
  if (present.length < 2) return null
  const lo = Math.min(...present)
  const span = Math.max(1, Math.max(...present) - lo)
  const x = (i: number) => (values.length <= 1 ? WIDTH / 2 : (i / (values.length - 1)) * WIDTH)
  const y = (v: number) => height - ((v - lo) / span) * height * 0.5

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${height}`}
      preserveAspectRatio="none"
      aria-hidden
      className="absolute inset-0 h-full w-full"
    >
      {segments(values).map((segment, j) => (
        <path key={j} d={areaPath(segment, x, y, height)} className="fill-ink/[0.07] stroke-none" />
      ))}
    </svg>
  )
}
