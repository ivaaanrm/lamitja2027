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
 * Written out rather than composed (`bg-${accent}-400`) because Tailwind resolves classes
 * by scanning the source — an interpolated name is a class that never ships.
 */
export const ACCENT: Record<
  SessionType,
  { rail: string; chip: string; text: string; dot: string }
> = {
  easy: { rail: 'bg-sky-400/50', chip: 'bg-sky-400/10 text-sky-300 ring-sky-400/20', text: 'text-sky-300', dot: 'bg-sky-400/60' },
  long: { rail: 'bg-violet-400', chip: 'bg-violet-400/10 text-violet-300 ring-violet-400/20', text: 'text-violet-300', dot: 'bg-violet-400' },
  tempo: { rail: 'bg-amber-400', chip: 'bg-amber-400/10 text-amber-300 ring-amber-400/20', text: 'text-amber-300', dot: 'bg-amber-400' },
  interval: { rail: 'bg-rose-400', chip: 'bg-rose-400/10 text-rose-300 ring-rose-400/20', text: 'text-rose-300', dot: 'bg-rose-400' },
  fartlek: { rail: 'bg-fuchsia-400', chip: 'bg-fuchsia-400/10 text-fuchsia-300 ring-fuchsia-400/20', text: 'text-fuchsia-300', dot: 'bg-fuchsia-400' },
  race: { rail: 'bg-emerald-400', chip: 'bg-emerald-400/10 text-emerald-300 ring-emerald-400/20', text: 'text-emerald-300', dot: 'bg-emerald-400' },
  rest: { rail: 'bg-neutral-700', chip: 'bg-neutral-500/10 text-neutral-400 ring-neutral-500/20', text: 'text-neutral-400', dot: 'bg-neutral-700' },
  cross: { rail: 'bg-cyan-400/70', chip: 'bg-cyan-400/10 text-cyan-300 ring-cyan-400/20', text: 'text-cyan-300', dot: 'bg-cyan-400/70' },
  strength: { rail: 'bg-teal-400/70', chip: 'bg-teal-400/10 text-teal-300 ring-teal-400/20', text: 'text-teal-300', dot: 'bg-teal-400/70' },
}

/**
 * One colour per heart-rate zone, cool to warm. Spelled out for the same reason `ACCENT`
 * is: Tailwind scans source, so a composed class name never ships.
 */
export const ZONE_ACCENT: Record<Zone, { bar: string; text: string }> = {
  1: { bar: 'bg-neutral-600', text: 'text-neutral-400' },
  2: { bar: 'bg-sky-400', text: 'text-sky-300' },
  3: { bar: 'bg-emerald-400', text: 'text-emerald-300' },
  4: { bar: 'bg-amber-400', text: 'text-amber-300' },
  5: { bar: 'bg-rose-400', text: 'text-rose-300' },
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
    done ? 'border-emerald-500 bg-emerald-500 text-ink' : 'border-line-strong text-transparent',
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
        className={cn('h-full rounded-full transition-[width]', pct >= 100 ? 'bg-emerald-400' : 'bg-label')}
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
        tone === 'done' && 'bg-emerald-500/15 text-emerald-400',
        tone === 'down' && 'bg-amber-500/15 text-amber-400',
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
        good === true && 'text-emerald-400',
        good === false && 'text-amber-400',
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
        variant === 'primary' && 'bg-label text-ink',
        variant === 'ghost' && 'bg-fill text-label',
        variant === 'danger' && 'bg-red-500/15 text-red-400',
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
