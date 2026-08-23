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
  className?: string
  /** Read by screen readers in place of the plot. */
  label: string
}) {
  const values = series.flatMap((s) => s.values).filter((v): v is number => v != null)
  const yMin = Math.min(yMinInput, ...values)
  const yMax = Math.max(yMaxInput ?? 0, ...values, yMin + 1)
  const x = (i: number) => (steps <= 1 ? 0 : (i / (steps - 1)) * WIDTH)
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
        />
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

      {series.map((s, i) => (
        <g key={i}>
          {s.areaClassName
            ? segments(s.values).map((segment, j) => (
                <path
                  key={j}
                  d={areaPath(segment, x, y, height)}
                  className={cn('stroke-none', s.areaClassName)}
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
              vectorEffect="non-scaling-stroke"
              className={s.className}
            />
          ))}
        </g>
      ))}
    </svg>
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
 */
export function BarRow({
  bars,
  height = 72,
  className,
}: {
  bars: Bar[]
  height?: number
  className?: string
}) {
  const peak = Math.max(
    1,
    ...bars.flatMap((b) => [b.value, b.ghost ?? 0, b.target ?? 0]),
  )
  const pct = (value: number) => `${Math.min(100, (value / peak) * 100)}%`

  return (
    <div className={cn('flex items-end gap-px', className)} style={{ height }}>
      {bars.map((bar) => (
        <div key={bar.key} className="relative flex h-full flex-1 items-end" title={bar.title}>
          {bar.ghost != null && bar.ghost > 0 ? (
            <span
              aria-hidden
              className="absolute bottom-0 w-full rounded-t-[2px] bg-ink/10"
              style={{ height: pct(bar.ghost) }}
            />
          ) : null}
          <span
            className={cn('relative w-full rounded-t-[2px]', bar.className ?? 'bg-label-3')}
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

/** A single bar split by share — the five zones, or anything else that adds to a whole. */
export function StackedBar({
  parts,
  className,
}: {
  parts: { value: number; className: string; key: string | number }[]
  className?: string
}) {
  const total = parts.reduce((sum, p) => sum + p.value, 0)
  if (total <= 0) return null

  return (
    <div className={cn('flex h-2.5 overflow-hidden rounded-full bg-fill', className)}>
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
