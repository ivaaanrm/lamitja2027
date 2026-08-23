import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import type { Zone } from '@/lib/paces'
import { SESSION_META, type SessionType } from '@/lib/plan'

/**
 * The handful of shapes this app repeats. Everything is sized for one thumb on a phone:
 * targets are 44px, nothing relies on hover, and numbers are tabular so they stop
 * jittering as they update.
 *
 * None of them is a box. A panel per section — border, fill, inner padding, repeated —
 * is what made the app read as a page of widgets, and on a 390px screen the repeated
 * inset costs more room than the content it frames. `Card` is now a band of one
 * continuous surface, divided from the next by a hairline drawn edge to edge; every
 * value it uses comes from the tokens in `src/styles/global.css`.
 */

/**
 * One colour per kind of session, so a week reads as a shape before it reads as words:
 * hard days are warm, endurance is violet, everything that is not running is cool.
 *
 * Each running type takes the hue Runna gives the same session — lime for the easy run,
 * violet for the long one, amber for tempo, coral for intervals, red for a race — because
 * those are the ones that have to be told apart at a glance in a week strip, and that
 * mapping is already tuned. Rest is the only type with no hue at all: it is the absence
 * of a session, so it gets the neutral fill and nothing else.
 *
 * Written out rather than composed (`bg-${accent}`) because Tailwind resolves classes by
 * scanning the source — an interpolated name is a class that never ships.
 */
export const ACCENT: Record<
  SessionType,
  { rail: string; chip: string; text: string; dot: string }
> = {
  easy: { rail: 'bg-lime', chip: 'bg-lime/12 text-lime ring-lime/25', text: 'text-lime', dot: 'bg-lime' },
  long: { rail: 'bg-violet', chip: 'bg-violet/12 text-violet ring-violet/25', text: 'text-violet', dot: 'bg-violet' },
  tempo: { rail: 'bg-amber', chip: 'bg-amber/12 text-amber ring-amber/25', text: 'text-amber', dot: 'bg-amber' },
  interval: { rail: 'bg-coral', chip: 'bg-coral/12 text-coral ring-coral/25', text: 'text-coral', dot: 'bg-coral' },
  fartlek: { rail: 'bg-green', chip: 'bg-green/12 text-green ring-green/25', text: 'text-green', dot: 'bg-green' },
  rest: { rail: 'bg-fill-strong', chip: 'bg-fill text-label-3 ring-line', text: 'text-label-3', dot: 'bg-fill-strong' },
  race: { rail: 'bg-red', chip: 'bg-red/12 text-red ring-red/25', text: 'text-red', dot: 'bg-red' },
  cross: { rail: 'bg-mint', chip: 'bg-mint/12 text-mint ring-mint/25', text: 'text-mint', dot: 'bg-mint' },
  strength: { rail: 'bg-blue', chip: 'bg-blue/12 text-blue ring-blue/25', text: 'text-blue', dot: 'bg-blue' },
}

/**
 * One colour per heart-rate zone, cool to warm — the same eight hues the session types
 * draw from, so a zone bar and a session rail are never two different greens. Spelled out
 * for the same reason `ACCENT` is: Tailwind scans source, so a composed class never ships.
 */
export const ZONE_ACCENT: Record<Zone, { bar: string; text: string }> = {
  1: { bar: 'bg-fill-strong', text: 'text-label-3' },
  2: { bar: 'bg-blue', text: 'text-blue' },
  3: { bar: 'bg-green', text: 'text-green' },
  4: { bar: 'bg-amber', text: 'text-amber' },
  5: { bar: 'bg-red', text: 'text-red' },
}

/** The session's kind, as a tinted label. */
export function TypeChip({ type, className }: { type: SessionType; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-caption2 font-semibold uppercase tracking-wider ring-1 ring-inset',
        ACCENT[type].chip,
        className,
      )}
    >
      {SESSION_META[type].label}
    </span>
  )
}

/**
 * A checkbox that is a target to a thumb, not a 16px square.
 *
 * The tick is drawn, not typed: `✓` is a glyph, so its weight and its baseline came from
 * whichever font the device happened to resolve, and it sat off-centre on iOS.
 *
 * The button stays 24px — the size of the face — and grows its *hit area* to 44px through
 * a pseudo-element instead. Growing the button itself (a negative margin, or padding) is
 * what a 44px target normally costs, and here it would eat the flex gap beside it and
 * push the circle out over the accent rail on its left.
 */
export function DoneToggle({
  done,
  label,
  onToggle,
}: {
  done: boolean
  label: string
  onToggle?: () => void
}) {
  const face = (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3.5"
    >
      <path d="m5 13 4.5 4.5L19 7" />
    </svg>
  )
  const shape = cn(
    'flex size-6 shrink-0 items-center justify-center rounded-full border transition-colors',
    done ? 'border-mint bg-mint text-surface' : 'border-line-strong text-transparent',
  )

  if (!onToggle)
    return (
      <span aria-hidden className={shape}>
        {face}
      </span>
    )
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={done}
      aria-label={done ? `Marcar ${label} como pendiente` : `Marcar ${label} como hecho`}
      className={cn(shape, 'relative active:opacity-60 after:absolute after:-inset-2.5 after:content-[""]')}
    >
      {face}
    </button>
  )
}

/**
 * One band of the page.
 *
 * Not a card: no border, no fill, no radius — it breaks out of the page gutter to draw a
 * hairline edge to edge, then puts the gutter back for its own content. The rule belongs
 * to the section below it and there is nothing above the first, which is how a grouped
 * list reads on iOS.
 */
export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section
      className={cn('-mx-gutter px-gutter py-4 [&:not(:first-child)]:hairline-t', className)}
    >
      {children}
    </section>
  )
}

/** A section's name, in the register iOS gives a grouped-list header: small, quiet, and
 *  close enough to what it labels that it does not need a box to claim it. */
export function CardTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-caption2 font-semibold uppercase tracking-[0.09em] text-label-3">
        {children}
      </h2>
      {action}
    </div>
  )
}

export function Stat({
  label,
  value,
  hint,
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
}) {
  return (
    <div>
      <dt className="text-caption2 uppercase tracking-[0.09em] text-label-3">{label}</dt>
      <dd className="mt-1 text-title3 font-semibold tabular-nums text-label">{value}</dd>
      {hint ? <p className="text-caption tabular-nums text-label-3">{hint}</p> : null}
    </div>
  )
}

/** Clamped at 100% width but reports the true percentage in its label — overshooting a
 *  volume target is information, not an error. */
export function ProgressBar({ value, target }: { value: number; target: number }) {
  const pct = target > 0 ? (value / target) * 100 : 0
  return (
    <div className="h-1 overflow-hidden rounded-full bg-fill">
      <div
        className={cn('h-full rounded-full transition-[width]', pct >= 100 ? 'bg-mint' : 'bg-label')}
        style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
      />
    </div>
  )
}

export function Chip({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'done' | 'down' }) {
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-caption font-medium',
        tone === 'done' && 'bg-mint/15 text-mint',
        tone === 'down' && 'bg-amber/15 text-amber',
        tone === 'neutral' && 'bg-fill text-label-2',
      )}
    >
      {children}
    </span>
  )
}

/**
 * A change against last season, or against anything else.
 *
 * `better` says which direction is good, because half these numbers want to go up
 * (volume, frequency) and half want to go down (days off, the longest gap) — and a green
 * arrow on a growing injury break would be the chart lying.
 */
export function Delta({
  value,
  better = 'up',
  className,
}: {
  /** A fraction: 0.18 reads as +18%. `null` when there is nothing to compare with. */
  value: number | null
  better?: 'up' | 'down'
  className?: string
}) {
  if (value == null) return <span className={cn('text-caption text-label-3', className)}>—</span>

  const rounded = Math.round(value * 100)
  const good = rounded === 0 ? null : (rounded > 0) === (better === 'up')

  return (
    <span
      className={cn(
        'text-caption font-medium tabular-nums',
        good === null && 'text-label-3',
        good === true && 'text-mint',
        good === false && 'text-amber',
        className,
      )}
    >
      {rounded > 0 ? '+' : rounded < 0 ? '\u2212' : '\u00b1'}
      {Math.abs(rounded)}%
    </span>
  )
}

/** An iOS segmented control: one row of mutually exclusive filters, thumb-sized. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
  className?: string
}) {
  return (
    <div
      role="tablist"
      className={cn('flex gap-1 rounded-xl bg-fill p-1', className)}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            'h-10 flex-1 rounded-lg text-footnote font-medium transition-colors',
            option.value === value ? 'bg-fill-strong text-label' : 'text-label-3 active:text-label-2',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Button({
  children,
  onClick,
  type = 'button',
  variant = 'ghost',
  disabled,
  className,
}: {
  children: ReactNode
  onClick?: () => void
  type?: 'button' | 'submit'
  variant?: 'primary' | 'ghost' | 'danger'
  disabled?: boolean
  className?: string
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        // Filled, not outlined: an outlined button is a web convention, and against a
        // surface with no panels behind it a border is the only box left on the screen.
        'inline-flex h-11 items-center justify-center rounded-xl px-4 text-subhead font-semibold active:opacity-60 disabled:opacity-40',
        variant === 'primary' && 'bg-mint text-surface',
        variant === 'ghost' && 'bg-fill text-label',
        variant === 'danger' && 'bg-red/15 text-red',
        className,
      )}
    >
      {children}
    </button>
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-caption2 uppercase tracking-[0.09em] text-label-3">{label}</span>
      <div className="mt-1.5">{children}</div>
    </label>
  )
}

/**
 * Filled rather than outlined, like every field iOS draws.
 *
 * `text-body` is 17px and load-bearing: Safari zooms the whole page in on a focused input
 * whose text is under 16px, and the old 14px controls did exactly that on every tap — the
 * page came back scrolled sideways with the dock off-screen.
 */
const CONTROL =
  'h-11 w-full rounded-xl bg-fill px-3.5 text-body text-label placeholder:text-label-3 outline-none focus:ring-2 focus:ring-inset focus:ring-line-strong'

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(CONTROL, props.className)} />
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cn(CONTROL, 'h-auto py-2.5 leading-relaxed', props.className)} />
}

/** A select with no chevron is a text input that ignores you when you type in it, so the
 *  affordance is drawn back on — `appearance-none` is what took the native one away. */
export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="relative block">
      <select {...props} className={cn(CONTROL, 'appearance-none pr-9', props.className)} />
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-label-3"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </span>
  )
}
