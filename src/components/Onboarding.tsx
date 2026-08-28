import { useEffect, useState } from 'react'
import {
  HALF_MARATHON_M,
  MAX_BLOCK_WEEKS,
  MIN_BLOCK_WEEKS,
  WEEK_MS,
  startOfDay,
  startOfWeek,
} from '@/lib/block'
import { cn } from '@/lib/cn'
import { Button, Field, TextInput } from './ui'
import { useBlock } from './useBlock'

/**
 * `<input type="date">` round-trips `YYYY-MM-DD`, and every date in this app is a
 * local-wall-clock epoch ms built as if it were UTC (`Date.UTC`, `startOfWeek`'s own
 * `getUTCDay`) — so both directions read and write the UTC fields, never the viewer's own
 * zone, or the value would drift a day for anyone west of it.
 */
function toDateInput(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}
function fromDateInput(value: string): number | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null
}

/** `1:19:59` or `38:00` → seconds. `null` for anything else, so a typo never saves as 0. */
function parseClock(value: string): number | null {
  const parts = value.trim().split(':')
  if (parts.length < 2 || parts.length > 3) return null
  const nums = parts.map(Number)
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null
  const [a, b, c] = nums
  if (parts.length === 3) return b! > 59 || c! > 59 ? null : a! * 3600 + b! * 60 + c!
  return b! > 59 ? null : a! * 60 + b!
}

async function errorMessage(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as {
    error?: string
    issues?: { message: string }[]
  } | null
  return body?.issues?.[0]?.message ?? body?.error ?? fallback
}

/** Which field a failed check points at, so the caret lands where the fix goes. */
type FieldName = 'race-name' | 'race-date' | 'goal-time' | 'block-start'

/**
 * First-run: the four numbers every other screen is built from — `useBlock` has nothing to
 * read until this PATCHes one in. Race distance is not asked here: the app is a half
 * marathon trainer end to end, so `HALF_MARATHON_M` is the default for every athlete this
 * invites, not just the owner.
 *
 * The four checks below repeat the block's own guardrails (`MIN_BLOCK_WEEKS`,
 * `MAX_BLOCK_WEEKS`) so a bad pair of dates fails here, at the field, rather than as a
 * server sentence with nowhere obvious to land — the round trip still happens and still
 * decides, this only spares it for the common typo.
 *
 * A block already on file — someone back-navigating after finishing this once — redirects
 * straight to `/plan` rather than re-rendering a form that would just overwrite it.
 * `useBlock` is read for exactly that one check; the form itself needs nothing from it.
 */
export function Onboarding() {
  const { data } = useBlock()

  useEffect(() => {
    if (data?.block) location.href = '/plan'
  }, [data])

  const [raceName, setRaceName] = useState('')
  const [raceDate, setRaceDate] = useState('')
  const [goalTime, setGoalTime] = useState('')
  const [blockStart, setBlockStart] = useState(() => toDateInput(startOfWeek(Date.now())))
  const [error, setError] = useState<string | null>(null)
  const [invalid, setInvalid] = useState<FieldName | null>(null)
  const [busy, setBusy] = useState(false)

  function fail(message: string, field: FieldName) {
    setError(message)
    setInvalid(field)
    document.getElementById(`ob-${field}`)?.focus()
  }

  function clear() {
    setError(null)
    setInvalid(null)
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    clear()

    if (!raceName.trim()) return fail('Escribe el nombre de la carrera.', 'race-name')

    const raceOn = fromDateInput(raceDate)
    if (raceOn == null) return fail('Elige la fecha de la carrera.', 'race-date')

    const goalTimeS = parseClock(goalTime)
    if (goalTimeS == null || goalTimeS <= 0) {
      return fail('El objetivo tiene que ir en formato 1:30:00.', 'goal-time')
    }

    const startsOnRaw = fromDateInput(blockStart)
    if (startsOnRaw == null) return fail('Elige cuándo empieza el bloque.', 'block-start')

    const startsOn = startOfWeek(startsOnRaw)
    const weeks = Math.ceil((startOfDay(raceOn) - startsOn) / WEEK_MS)
    if (weeks < MIN_BLOCK_WEEKS || weeks > MAX_BLOCK_WEEKS) {
      return fail(
        `Con esas fechas el bloque dura ${weeks} semanas: tiene que estar entre ${MIN_BLOCK_WEEKS} y ${MAX_BLOCK_WEEKS}.`,
        'race-date',
      )
    }

    setBusy(true)
    try {
      const response = await fetch('/api/profile', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          block: {
            startsOn,
            raceOn,
            goalTimeS,
            raceDistanceM: HALF_MARATHON_M,
            raceName: raceName.trim(),
          },
        }),
      })
      if (response.status === 401) {
        location.href = '/login'
        return
      }
      if (!response.ok) throw new Error(await errorMessage(response, 'No se pudo guardar'))

      // A document load: `/plan` reads the block `useBlock` has just been given, and
      // `busy` stays true because the page is already on its way out.
      location.href = '/plan'
      return
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se ha podido conectar. Vuelve a intentarlo.')
    }
    setBusy(false)
  }

  const mark = (field: FieldName) => ({
    'aria-invalid': invalid === field,
    className: 'aria-[invalid=true]:border-red',
  })

  return (
    <form
      noValidate
      onSubmit={(event) => void submit(event)}
      aria-busy={busy}
      className="fade-up rounded-2xl bg-fill p-4"
    >
      <Field label="Nombre de la carrera">
        <TextInput
          id="ob-race-name"
          value={raceName}
          onChange={(e) => {
            setRaceName(e.target.value)
            clear()
          }}
          enterKeyHint="next"
          aria-describedby="ob-error"
          {...mark('race-name')}
        />
      </Field>

      <div className="mt-3">
        <Field label="Fecha de la carrera">
          <TextInput
            id="ob-race-date"
            type="date"
            value={raceDate}
            onChange={(e) => {
              setRaceDate(e.target.value)
              clear()
            }}
            aria-describedby="ob-error"
            {...mark('race-date')}
          />
        </Field>
      </div>

      <div className="mt-3">
        <Field label="Objetivo">
          <TextInput
            id="ob-goal-time"
            inputMode="numeric"
            placeholder="1:30:00"
            value={goalTime}
            onChange={(e) => {
              setGoalTime(e.target.value)
              clear()
            }}
            enterKeyHint="next"
            aria-describedby="ob-error"
            {...mark('goal-time')}
          />
        </Field>
      </div>

      <div className="mt-3">
        <Field label="Empieza el bloque">
          <TextInput
            id="ob-block-start"
            type="date"
            value={blockStart}
            onChange={(e) => {
              setBlockStart(e.target.value)
              clear()
            }}
            aria-describedby="ob-block-start-hint ob-error"
            {...mark('block-start')}
          />
        </Field>
        <p id="ob-block-start-hint" className="mt-2 text-caption leading-relaxed text-label-3">
          Se ajusta al lunes de esa semana — cada semana del bloque cuenta desde ahí.
        </p>
      </div>

      <p
        id="ob-error"
        role="alert"
        className={cn('mt-3 text-footnote leading-relaxed text-red', !error && 'hidden')}
      >
        {error}
      </p>

      <Button type="submit" variant="primary" disabled={busy} className="mt-3 w-full">
        {busy ? 'Guardando…' : 'Continuar'}
      </Button>
    </form>
  )
}
