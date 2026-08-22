import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * The handful of shapes this app repeats. Everything is sized for one thumb on a phone:
 * controls are 44px tall, nothing relies on hover, and numbers are tabular so they stop
 * jittering as they update.
 */

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-2xl border border-neutral-800 bg-neutral-900/50 p-5', className)}>
      {children}
    </section>
  )
}

export function CardTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <h2 className="text-xs font-medium uppercase tracking-widest text-neutral-500">{children}</h2>
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
      <dt className="text-[0.6875rem] uppercase tracking-widest text-neutral-500">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums">{value}</dd>
      {hint ? <p className="text-xs tabular-nums text-neutral-500">{hint}</p> : null}
    </div>
  )
}

/** Clamped at 100% width but reports the true percentage in its label — overshooting a
 *  volume target is information, not an error. */
export function ProgressBar({ value, target }: { value: number; target: number }) {
  const pct = target > 0 ? (value / target) * 100 : 0
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-neutral-800">
      <div
        className={cn('h-full rounded-full transition-[width]', pct >= 100 ? 'bg-emerald-500' : 'bg-neutral-300')}
        style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
      />
    </div>
  )
}

export function Chip({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'done' | 'down' }) {
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-[0.6875rem] font-medium',
        tone === 'done' && 'bg-emerald-500/15 text-emerald-400',
        tone === 'down' && 'bg-amber-500/15 text-amber-400',
        tone === 'neutral' && 'bg-neutral-800 text-neutral-400',
      )}
    >
      {children}
    </span>
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
        'inline-flex h-11 items-center justify-center rounded-xl px-4 text-sm font-medium active:opacity-70 disabled:opacity-40',
        variant === 'primary' && 'bg-neutral-100 text-neutral-950',
        variant === 'ghost' && 'border border-neutral-700 text-neutral-200',
        variant === 'danger' && 'border border-red-900/70 text-red-400',
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
      <span className="text-[0.6875rem] uppercase tracking-widest text-neutral-500">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  )
}

const CONTROL =
  'h-11 w-full rounded-xl border border-neutral-700 bg-neutral-950 px-3 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none'

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(CONTROL, props.className)} />
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cn(CONTROL, 'h-auto py-2.5 leading-relaxed', props.className)} />
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cn(CONTROL, 'appearance-none', props.className)} />
}
