import { Children, useEffect, useState, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { zoneTag, type Zone } from '@/lib/paces'
import { SESSION_META, type SessionType } from '@/lib/plan'

/**
 * The handful of shapes this app repeats. Everything is sized for one thumb on a phone:
 * targets are 44px, nothing relies on hover, and numbers are tabular so they stop
 * jittering as they update.
 *
 * Cards establish one clear level of grouping without inventing colours or hiding data.
 * The flat fill and radius are shared, so dense analytics still read as one app without
 * every section pretending to float above the page.
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
 * scanning the source — an interpolated name is a class that never ships. That is also why
 * `swatch` spells both gradient stops: the hue fading to 60% of itself over a dark ground
 * is what makes a 28px square read as an object rather than as a colour chip, and
 * `from-${hue}` would ship nothing at all. Rest is the only type with no gradient, because
 * it is the only one with no hue.
 */
export const ACCENT: Record<
  SessionType,
  { rail: string; chip: string; text: string; dot: string; swatch: string }
> = {
  easy: { rail: 'bg-lime', chip: 'bg-lime/12 text-lime ring-lime/25', text: 'text-lime', dot: 'bg-lime', swatch: 'bg-linear-to-br from-lime to-lime/60' },
  long: { rail: 'bg-violet', chip: 'bg-violet/12 text-violet ring-violet/25', text: 'text-violet', dot: 'bg-violet', swatch: 'bg-linear-to-br from-violet to-violet/60' },
  tempo: { rail: 'bg-amber', chip: 'bg-amber/12 text-amber ring-amber/25', text: 'text-amber', dot: 'bg-amber', swatch: 'bg-linear-to-br from-amber to-amber/60' },
  interval: { rail: 'bg-coral', chip: 'bg-coral/12 text-coral ring-coral/25', text: 'text-coral', dot: 'bg-coral', swatch: 'bg-linear-to-br from-coral to-coral/60' },
  fartlek: { rail: 'bg-green', chip: 'bg-green/12 text-green ring-green/25', text: 'text-green', dot: 'bg-green', swatch: 'bg-linear-to-br from-green to-green/60' },
  rest: { rail: 'bg-fill-strong', chip: 'bg-fill text-label-3 ring-line', text: 'text-label-3', dot: 'bg-fill-strong', swatch: 'bg-fill' },
  race: { rail: 'bg-red', chip: 'bg-red/12 text-red ring-red/25', text: 'text-red', dot: 'bg-red', swatch: 'bg-linear-to-br from-red to-red/60' },
  cross: { rail: 'bg-mint', chip: 'bg-mint/12 text-mint ring-mint/25', text: 'text-mint', dot: 'bg-mint', swatch: 'bg-linear-to-br from-mint to-mint/60' },
  strength: { rail: 'bg-blue', chip: 'bg-blue/12 text-blue ring-blue/25', text: 'text-blue', dot: 'bg-blue', swatch: 'bg-linear-to-br from-blue to-blue/60' },
}

/**
 * One colour per heart-rate zone, cool to warm — the same eight hues the session types
 * draw from, so a zone bar and a session rail are never two different greens. Spelled out
 * for the same reason `ACCENT` is: Tailwind scans source, so a composed class never ships.
 */
export const ZONE_ACCENT: Record<Zone, { bar: string; text: string; chip: string }> = {
  1: { bar: 'bg-fill-strong', text: 'text-label-3', chip: 'bg-fill text-label-2 ring-line' },
  2: { bar: 'bg-blue', text: 'text-blue', chip: 'bg-blue/12 text-blue ring-blue/25' },
  3: { bar: 'bg-green', text: 'text-green', chip: 'bg-green/12 text-green ring-green/25' },
  4: { bar: 'bg-amber', text: 'text-amber', chip: 'bg-amber/12 text-amber ring-amber/25' },
  5: { bar: 'bg-red', text: 'text-red', chip: 'bg-red/12 text-red ring-red/25' },
}

/** The zone a step is run in, as the same tinted label a session's type wears. */
export function ZoneChip({ zone, className }: { zone: Zone; className?: string }) {
  return (
    <span
      className={cn(
        'data-number inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-caption2 font-semibold ring-1 ring-inset',
        ZONE_ACCENT[zone].chip,
        className,
      )}
    >
      {zoneTag(zone)}
    </span>
  )
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

// ---------------------------------------------------------------------------
// Glyphs
//
// One wrapper and a list of paths. Eight pasted `<svg>` blocks at three stroke weights is
// how a screen ends up looking assembled rather than designed — a chevron 2px thicker than
// the arrow beside it is drift the eye reads before it reads either glyph.
//
// The wrapper fixes everything that must not vary: the 24-unit box, the round caps, and
// `aria-hidden` — a glyph is never the label, it always sits beside one. What is left to
// the caller is the path, the size and the weight.
//
// One weight per size: 2 at `size-4` and `size-3.5`, 2.5 at `size-3`, because a 12px glyph
// at 2 goes grey before it goes small.
// ---------------------------------------------------------------------------

export const CHEVRON_RIGHT = 'm9 6 6 6-6 6'
export const CHEVRON_LEFT = 'm15 6-6 6 6 6'
export const CHEVRON_DOWN = 'm6 9 6 6 6-6'
export const ARROW_OUT = 'M7 17 17 7M9 7h8v8'
export const PLUS = 'M12 5v14M5 12h14'
export const CHECK = 'm5 13 4.5 4.5L19 7'

export function Icon({
  path,
  strokeWidth = 2,
  className,
}: {
  /** One of the exported constants above. A path this file does not name is a new glyph. */
  path: string
  strokeWidth?: number
  className?: string
}) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('size-4 shrink-0', className)}
    >
      <path d={path} />
    </svg>
  )
}

/**
 * The disclosure triangle on an expandable row — right when closed, down when open.
 *
 * `label-4` is chrome-only and this is exactly the chrome it is for: the row's words carry
 * the meaning, the triangle only says the row opens.
 */
export function Chevron({ open }: { open: boolean }) {
  return (
    <Icon
      path={CHEVRON_RIGHT}
      strokeWidth={2.5}
      className={cn(
        'motion-standard size-3 text-label-4 transition-transform',
        open && 'rotate-90',
      )}
    />
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
  // Heavier than the icon default: this one is drawn *inside* a filled 24px disc, where a
  // 2-weight tick disappears into the accent.
  const face = <Icon path={CHECK} strokeWidth={3.5} className="size-3.5" />
  const shape = cn(
    'motion-standard flex size-6 shrink-0 items-center justify-center rounded-full border transition-colors',
    done ? 'border-accent bg-accent text-surface' : 'border-line-strong text-transparent',
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
 * One grouped surface, sized to keep useful data above the fold on a 375 px phone.
 *
 * Flat by design: the same translucent fill as a week group and the countdown, with no
 * outline or shadow. Grouping comes from the change of ground and the radius; drawing a
 * second edge around both was framing every section twice.
 *
 * `px-3 py-2.5` rather than a symmetric `p-4`: the horizontal inset is doing less work
 * here because the page gutter already holds the card off the bezel, so spending 16px on
 * both is spending it twice. The radius comes down with the padding — a 24px corner on a
 * card this tight reads as bulbous, and `rounded-2xl` keeps the corner proportional to
 * the inset it wraps.
 */
export function Card({
  children,
  className,
  ...rest
}: { children: ReactNode; className?: string } & React.ComponentPropsWithoutRef<'section'>) {
  return (
    <section
      {...rest}
      className={cn('rounded-2xl bg-fill px-3 py-2.5', className)}
    >
      {children}
    </section>
  )
}

/** A section name that is quiet but still anchors the scanning order. */
export function CardTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <h2 className="text-caption2 font-semibold uppercase tracking-[0.12em] text-label-2">
        {children}
      </h2>
      {action}
    </div>
  )
}

/**
 * One number with its name above it and its context under it — the atom every stat grid
 * and every `StatStrip` is built from.
 *
 * The hint lives *inside* the `<dd>` rather than beside it. A `<dl>` may only contain
 * `<dt>`, `<dd>` and grouping `<div>`s, so a third sibling was invalid markup that only
 * happened to render; and semantically the hint is part of the answer ("42 km, of 55
 * planned"), not a separate term.
 */
export function Stat({
  label,
  value,
  hint,
  className,
}: {
  label: string
  value: ReactNode
  /** What the number is measured against: `de 55 previstos`, `objetivo 3:47/km`. */
  hint?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <dt className="text-caption2 uppercase tracking-[0.09em] text-label-3">{label}</dt>
      <dd className="mt-0.5">
        <span className="data-number block text-body font-semibold leading-tight text-label">
          {value}
        </span>
        {hint ? (
          <span className="mt-0.5 block text-caption2 tabular-nums text-label-3">{hint}</span>
        ) : null}
      </dd>
    </div>
  )
}

/**
 * A share of a target as a straight line. Clamped at full width, but the caller's label
 * still reports the true percentage — overshooting a volume target is information, not an
 * error.
 *
 * The fill is a `scaleX`, not a `width`: the two look identical and only one of them is
 * free. A width transition relayouts the bar on every frame; a transform is handed to the
 * compositor and never touches layout at all. The rounded caps come from the track's own
 * `overflow-hidden`, so the squash a scale would put on the fill's corners never renders.
 *
 * Use this for a share that is *incidental* to the card — a week's line in a list of
 * weeks. When the share is what the card is about, `ProgressRing` is the shape.
 */
export function ProgressBar({
  value,
  target,
  barClassName,
  className,
}: {
  value: number
  target: number
  /** Override the fill — a session-type hue, say. Defaults to ink, accent once complete. */
  barClassName?: string
  className?: string
}) {
  const pct = target > 0 ? (value / target) * 100 : 0
  return (
    <div className={cn('h-1.5 overflow-hidden rounded-full bg-fill-strong', className)}>
      <div
        className={cn(
          'h-full w-full origin-left rounded-full transition-transform duration-[var(--duration-sheet)] ease-ios',
          barClassName ?? (pct >= 100 ? 'bg-accent' : 'bg-label'),
        )}
        style={{ transform: `scaleX(${Math.min(1, Math.max(0, pct / 100))})` }}
      />
    </div>
  )
}

export function Chip({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'done' | 'down' }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-caption2 font-medium',
        tone === 'done' && 'bg-accent/15 text-accent',
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
        good === true && 'text-accent',
        good === false && 'text-amber',
        className,
      )}
    >
      {rounded > 0 ? '+' : rounded < 0 ? '\u2212' : '\u00b1'}
      {Math.abs(rounded)}%
    </span>
  )
}

/**
 * One row of mutually exclusive choices, thumb-sized. Filled is the iOS segmented
 * control used inside cards; underline is the quieter treatment used by page navigation.
 *
 * A `radiogroup`, not a `tablist`. It read as tabs before, and that is a promise the
 * control cannot keep: a tab owns a `tabpanel`, points at it with `aria-controls`, and is
 * reached with the arrow keys from a single tab stop — so a reader announcing "pestaña 2
 * de 3" sent someone looking for a panel that does not exist, on a control that is
 * filtering the card it sits inside. Radios are what this actually is: one choice out of a
 * few, changing what is already on screen.
 *
 * Which brings the roving tabindex with it, because that is how a radio group is operated
 * everywhere: one tab stop for the whole group, the arrows move between the options *and*
 * select as they go. Nine lines, and without them the group would claim a role whose
 * keyboard contract it does not honour — which is the same bug over again in a different
 * word.
 *
 * Nothing about the phone changes: the targets are still `h-11`, still 44px, still
 * selected by tapping them.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
  variant = 'filled',
  /** Spanish, and worth writing whenever the card's title does not already say it. */
  label,
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
  className?: string
  /** `underline` is the quiet navigation treatment; cards keep the filled control. */
  variant?: 'filled' | 'underline'
  label?: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        'flex',
        variant === 'filled' ? 'gap-0.5 rounded-lg bg-surface-deep/55 p-0.5' : 'gap-0',
        className,
      )}
    >
      {options.map((option, i) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            // The roving stop: the group is one tab stop, and it lands on the current
            // choice rather than always on the first.
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              const step =
                event.key === 'ArrowRight' || event.key === 'ArrowDown'
                  ? 1
                  : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                    ? -1
                    : 0
              if (step === 0) return
              event.preventDefault()

              const at = (i + step + options.length) % options.length
              const next = options[at]
              if (!next) return
              onChange(next.value)
              // Focus follows selection, which is the half of the contract the role
              // promises. The buttons are the group's own children, so this needs no refs.
              const sibling = event.currentTarget.parentElement?.children[at]
              if (sibling instanceof HTMLElement) sibling.focus()
            }}
            className={cn(
              'motion-standard h-11 flex-1 text-footnote font-medium transition-colors',
              variant === 'filled' && 'rounded-[0.375rem]',
              variant === 'underline' &&
                'relative rounded-none after:absolute after:-bottom-px after:inset-x-2 after:h-0.5 after:rounded-t-full after:bg-transparent after:transition-colors after:content-[""]',
              variant === 'filled' &&
                (selected
                  ? 'bg-surface-raised text-label shadow-sm'
                  : 'text-label-3 active:bg-fill active:text-label-2'),
              variant === 'underline' &&
                (selected
                  ? 'font-semibold text-label after:bg-label'
                  : 'text-label-3 active:text-label-2'),
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

export function Button({
  children,
  href,
  onClick,
  type = 'button',
  variant = 'ghost',
  disabled,
  className,
}: {
  children: ReactNode
  /** A link renders an `<a>` wearing the same shape — a navigation action is still one. */
  href?: string
  onClick?: () => void
  type?: 'button' | 'submit'
  variant?: 'primary' | 'ghost' | 'danger'
  disabled?: boolean
  className?: string
}) {
  const shape = cn(
    // Filled, not outlined: an outlined button is a web convention, and against a
    // surface with no panels behind it a border is the only box left on the screen.
    // h-11 is 44px — the touch-target floor, not a number to shave further.
    'tappable inline-flex h-11 items-center justify-center rounded-xl px-4 text-footnote font-semibold disabled:opacity-40',
    variant === 'primary' && 'bg-accent text-surface',
    variant === 'ghost' && 'bg-fill text-label',
    variant === 'danger' && 'bg-red/15 text-red',
    className,
  )

  if (href)
    return (
      <a href={href} className={shape}>
        {children}
      </a>
    )
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={shape}>
      {children}
    </button>
  )
}

/**
 * The other kind of action: a word, underlined, with no box around it.
 *
 * `Button` is the filled shape for the thing a card is *for*; this is the shape for the
 * thing beside it — "Editar plan" in a `CardTitle`, "Ver la siguiente" over a pinned day,
 * the one link an `EmptyState` offers. It was hand-rolled in six places at three different
 * sizes before it lived here, which is four screens' worth of the same underline drifting
 * apart, and `CardTitle`'s action slot is the one place every screen touches.
 *
 * Two tones and no more: `quiet` for a secondary action sitting next to content that
 * matters more, `primary` when the link *is* the fix an empty card is offering — accent,
 * because accent is state and "here is what to do next" is the state that card reports.
 *
 * `inset` is the pull-back a 44px target needs when it shares a row with a 12px heading:
 * the hit area stays 44px and the row keeps the height of its text.
 */
export function TextLink({
  href,
  onClick,
  disabled,
  tone = 'quiet',
  inset = false,
  className,
  children,
}: {
  /** A link renders an `<a>`; without one it renders a `<button>`. */
  href?: string
  onClick?: () => void
  disabled?: boolean
  tone?: 'quiet' | 'primary'
  inset?: boolean
  className?: string
  children: ReactNode
}) {
  const shape = cn(
    'tappable inline-flex min-h-11 items-center underline underline-offset-4',
    tone === 'quiet' && 'text-caption text-label-2',
    tone === 'primary' && 'text-footnote font-semibold text-accent',
    inset && '-my-2 px-2',
    className,
  )

  if (href)
    return (
      <a href={href} className={shape}>
        {children}
      </a>
    )
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(shape, 'disabled:opacity-50')}
    >
      {children}
    </button>
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-caption2 uppercase tracking-[0.09em] text-label-3">{label}</span>
      <div className="mt-0.5">{children}</div>
    </label>
  )
}

/**
 * Filled rather than outlined, like every field iOS draws.
 *
 * Two measurements in here are pinned and are the reason a form cannot simply be made
 * smaller. `text-body` is 17px because Safari zooms the whole page in on a focused input
 * whose text is under 16px — the old 14px controls did exactly that on every tap, and the
 * page came back scrolled sideways with the dock off-screen. `h-11` is the 44px touch
 * floor. What a tighter form buys instead is everything around them: no resting border, a
 * corner proportional to the inset, and less horizontal padding.
 *
 * Borderless at rest and bordered on focus, rather than a hairline that is always on. A
 * field is already a well — `surface-deep/35` against the content fill it sits on — so
 * the rule was a second edge drawn around an edge, and eight of them stacked down a form
 * read as a grid of boxes. `border-transparent` rather than no border at all, so the box
 * does not resize by two pixels the moment it takes focus.
 */
const CONTROL =
  'motion-standard h-11 w-full rounded-lg border border-transparent bg-surface-deep/35 px-2.5 text-body text-label placeholder:text-label-3 outline-none transition-colors focus:border-line-strong focus:bg-fill'

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(CONTROL, props.className)} />
}

/**
 * `field-sizing-content` is what makes this the field for prose: it grows to whatever it
 * holds, so a week's focus is read whole rather than scrolled sideways through a slot.
 * `rows` is the floor it starts from, and the fallback wherever the property is not
 * supported — there it scrolls, which is the old behaviour rather than a broken one.
 */
export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      rows={2}
      {...props}
      className={cn(CONTROL, 'h-auto field-sizing-content py-2 leading-snug', props.className)}
    />
  )
}

/** A select with no chevron is a text input that ignores you when you type in it, so the
 *  affordance is drawn back on — `appearance-none` is what took the native one away. */
export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="relative block">
      <select {...props} className={cn(CONTROL, 'appearance-none pr-9', props.className)} />
      <Icon
        path={CHEVRON_DOWN}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-label-3"
      />
    </span>
  )
}

// ---------------------------------------------------------------------------
// The four signature shapes
//
// The brief names four widgets and says they carry the whole app: a hero metric, a
// progress ring, a compact stat strip and a segmented control. Three of them used to be
// hand-rolled per screen — a display-sized number assembled from two spans here, an SVG
// ring pasted into a preview page there — which is precisely how six screens drift into
// six design systems. They live here now, and a screen that needs a fifth shape does not
// need a fifth shape.
// ---------------------------------------------------------------------------

/**
 * The one number a screen is about.
 *
 * There is exactly one of these per screen and it sits at the top: it is the answer to
 * "how am I doing" before a finger has moved. The generosity the density rules hold back
 * from the grid is spent right here — the value is `text-display` on its own line box,
 * the unit rides its baseline at `footnote` so the digits keep the whole optical weight,
 * and the context line underneath is the sentence that stops the number being trivia
 * ("+12% respecto a la temporada pasada", "de 55 km previstos").
 *
 * `trailing` is the slot for the one thing allowed to sit beside it — a `ProgressRing`, a
 * `Delta`, a `Sparkline`. One of those, never two: a hero metric with a ring *and* a
 * sparkline is two focal points, which is none.
 */
export function HeroMetric({
  eyebrow,
  value,
  unit,
  context,
  trailing,
  className,
}: {
  /** The quiet line above — `Semana 12 de 23`, `Últimos 42 días`. */
  eyebrow?: ReactNode
  /** Already formatted through `decimal()`. This component does not do arithmetic. */
  value: ReactNode
  unit?: ReactNode
  /** One line. If it needs two sentences it belongs in the card, not in the hero. */
  context?: ReactNode
  trailing?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex items-center justify-between gap-3', className)}>
      <div className="min-w-0 flex-1">
        {eyebrow ? (
          <p className="text-caption2 font-semibold uppercase tracking-[0.16em] text-label-3">
            {eyebrow}
          </p>
        ) : null}
        <p className="data-number mt-1.5 font-display text-display font-bold leading-none text-label">
          {value}
          {unit ? (
            <span className="ml-1.5 font-sans text-footnote font-normal tracking-normal text-label-3">
              {unit}
            </span>
          ) : null}
        </p>
        {context ? (
          <p className="mt-2 text-footnote leading-relaxed text-label-2">{context}</p>
        ) : null}
      </div>
      {trailing ? <div className="shrink-0">{trailing}</div> : null}
    </div>
  )
}

/**
 * A share of a target, drawn as an arc.
 *
 * The ring is the shape for a share the card is *about* — the week's volume, the sessions
 * ticked off, the days left to race. A bar is the shape for a share that is incidental to
 * a row. Picking by that rule rather than by taste is what keeps three screens from
 * showing the same quantity three ways.
 *
 * Two details are load-bearing:
 *
 *   `pathLength={1}` normalises the circumference, so the arc is `1 - share` of dash
 *   offset at any radius and no one has to write `2πr` into a component again.
 *
 *   The arc mounts at zero and is moved to its real value in an effect. That is the
 *   reveal — the ring fills as the card lands — and it is also what makes the component
 *   safe under prerender, where there is no client to run the effect and the static HTML
 *   is simply an empty track. Nothing here reads `window`.
 *
 * Overshoot is clamped at a full ring; say the real number in `label` or beside it, the
 * way `ProgressBar` does. A 118% week is information, but an arc that laps itself is not
 * a reading anyone takes off a 64px circle.
 */
export function ProgressRing({
  value,
  target,
  size = 64,
  stroke = 6,
  label,
  sublabel,
  arcClassName,
  trackClassName = 'stroke-fill-strong',
  className,
  ariaLabel,
}: {
  value: number
  target: number
  /** Rendered px. 44 in a row, 64 beside a hero, 88 when the ring *is* the card. */
  size?: number
  /** Rendered px of ring thickness. */
  stroke?: number
  /** The glyph in the middle — a percentage, a count, a number of days. */
  label?: ReactNode
  /** One quiet word under it: `km`, `sesiones`, `días`. */
  sublabel?: ReactNode
  /** Defaults to ink, accent once the target is met — the same state colour as the bar. */
  arcClassName?: string
  trackClassName?: string
  className?: string
  /** Spanish, and required whenever `label` alone does not say what the share is of. */
  ariaLabel?: string
}) {
  const share = target > 0 ? Math.min(1, Math.max(0, value / target)) : 0
  const [drawn, setDrawn] = useState(0)
  useEffect(() => setDrawn(share), [share])

  // The geometry is a 100-unit box scaled by CSS, so `size` never touches the maths — only
  // the stroke has to be converted, or a 44px ring and an 88px ring would not be the same
  // drawing at two sizes.
  const width = (stroke / size) * 100
  const radius = (100 - width) / 2

  return (
    <div
      className={cn('relative shrink-0', className)}
      style={{ width: size, height: size }}
      role={ariaLabel ? 'img' : undefined}
      aria-label={ariaLabel}
    >
      <svg viewBox="0 0 100 100" className="size-full -rotate-90" aria-hidden>
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          strokeWidth={width}
          className={trackClassName}
        />
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          strokeWidth={width}
          strokeLinecap="round"
          pathLength={1}
          strokeDasharray={1}
          strokeDashoffset={1 - drawn}
          className={cn(
            'transition-[stroke-dashoffset] duration-[var(--duration-sheet)] ease-ios',
            arcClassName ?? (share >= 1 ? 'stroke-accent' : 'stroke-label'),
          )}
        />
      </svg>
      {label != null ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-px">
          <span className="data-number text-footnote font-semibold leading-none text-label">
            {label}
          </span>
          {sublabel ? (
            <span className="text-caption2 leading-none text-label-3">{sublabel}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

const STRIP_COLS: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-2',
  3: 'grid-cols-3',
  4: 'grid-cols-4',
}

/**
 * Three or four `Stat`s on one row, ruled apart.
 *
 * The row is a grid rather than a flex line so the columns are equal and the numbers line
 * up down the card when two strips stack — a flex row sized by content puts every strip's
 * second number in a different place, which is what made the old stat rows read as noise.
 *
 * Four is the ceiling at 375px: a fifth column leaves ~70px for a label, a value and a
 * hint, and something wraps. Five numbers means the card is asking two questions, so drop
 * one — the density rule is "fewer elements", not "tighter padding".
 *
 * The divider is drawn on the wrapper, not on `Stat`, so a `Stat` outside a strip carries
 * no stray rule. Column classes are spelled out in `STRIP_COLS` for the usual reason: an
 * interpolated `grid-cols-${n}` is a class Tailwind never sees and therefore never ships.
 */
export function StatStrip({ children, className }: { children: ReactNode; className?: string }) {
  const items = Children.toArray(children)
  return (
    <dl className={cn('grid', STRIP_COLS[Math.min(4, Math.max(1, items.length))], className)}>
      {items.map((child, i) => (
        <div key={i} className={cn('min-w-0 px-2.5 first:pl-0 last:pr-0', i > 0 && 'border-l border-line')}>
          {child}
        </div>
      ))}
    </dl>
  )
}

/**
 * A placeholder shaped like the thing that is coming.
 *
 * Never a spinner: a spinner says "wait" and says nothing about what for, while a block
 * the size of the hero number tells the eye where to be when the data lands, and the card
 * does not jump when it does. Give it the real dimensions of what it stands in for —
 * `h-9 w-28` for a display metric, `h-3 w-full` for a line of prose.
 *
 * `aria-hidden`, always: the screen reader's answer to a loading card is the `aria-busy`
 * on the region, not a description of grey rectangles.
 */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cn('skeleton block rounded-md', className)} />
}

/**
 * The loading state of a whole card, for the four screens that all used to render the
 * word "Cargando…" and a blank.
 *
 * It is deliberately generic — a title bar, a hero-sized block, then rows. A screen whose
 * first card is not that shape should compose its own from `Skeleton` instead; matching
 * the real layout is the whole point of a skeleton, and a wrong shape is worse than none
 * because the card then visibly rearranges itself.
 */
export function LoadingCard({
  rows = 3,
  hero = true,
  busy = true,
}: {
  rows?: number
  hero?: boolean
  /**
   * Each wait announces itself once. The first card of a wait carries the `aria-busy`; the
   * cards behind it are `aria-hidden`, because three "Cargando" regions for one request is
   * three announcements of one fact.
   */
  busy?: boolean
}) {
  return (
    // No `fade-up`: the skeleton already breathes, and the real card fades up as it
    // replaces it. Two reveals over the same pixels inside half a second is a flicker.
    <Card
      aria-busy={busy ? 'true' : undefined}
      aria-label={busy ? 'Cargando' : undefined}
      aria-hidden={busy ? undefined : true}
    >
      <Skeleton className="h-2.5 w-24" />
      {hero ? <Skeleton className="mt-3 h-8 w-32" /> : null}
      <div className="mt-3 space-y-2">
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} className={cn('h-3', i === rows - 1 ? 'w-2/3' : 'w-full')} />
        ))}
      </div>
    </Card>
  )
}

/**
 * Nothing to show, said in a sentence.
 *
 * Checklist item 4: an empty card is a bug, and "Sin datos" is the same bug with a label
 * on it. The sentence has to say *why* it is empty and, where there is one, what to do —
 * "Aún no hay ninguna salida con pulso. Las zonas se leen del pulsómetro." No icon and no
 * illustration: at 375px a decorative glyph above two lines of text is a marketing empty
 * state, and the athlete opening this screen at 6am does not need to be cheered up.
 */
export function EmptyState({
  children,
  action,
  className,
}: {
  /** Spanish, one or two sentences, and specific about what is missing. */
  children: ReactNode
  /** A `Button`, or a plain underlined link. Optional — most empty states have no fix. */
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('py-1', className)}>
      <p className="text-footnote leading-relaxed text-label-3">{children}</p>
      {action ? <div className="mt-2.5">{action}</div> : null}
    </div>
  )
}

/**
 * A fetch that did not come back, said the same way on every screen.
 *
 * Five screens used to answer this in four shapes — two containers, two button variants,
 * and on `/progreso` no retry at all, which left a dropped connection as a permanently
 * blank tab. The shape is settled here instead: what failed as a heading, the reason in
 * red, the way out as the primary action.
 *
 * `role="alert"` because the failure arrives *after* the screen has: the reader is already
 * somewhere else on the page by the time the fetch gives up. Red is never the only carrier
 * — the heading names what is missing and the sentence says it in words.
 */
export function ErrorCard({
  title,
  message,
  hint,
  onRetry,
}: {
  /** What is missing, in Spanish: `Sin datos del bloque`, `Traza`. */
  title: string
  message: string
  /** What it means, when the default ("check the connection") is not the whole story. */
  hint?: ReactNode
  onRetry: () => void
}) {
  return (
    <Card className="fade-up">
      <CardTitle>{title}</CardTitle>
      <EmptyState
        action={
          <Button variant="primary" onClick={onRetry}>
            Reintentar
          </Button>
        }
      >
        <span role="alert" className="text-red">
          {message}
        </span>{' '}
        {hint ?? 'Comprueba la conexión y vuelve a intentarlo.'}
      </EmptyState>
    </Card>
  )
}
