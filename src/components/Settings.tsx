import { useEffect, useState } from 'react'
import { formatClock } from '@/lib/activity'
import { MAX_BLOCK_WEEKS, MIN_BLOCK_WEEKS, WEEK_MS, startOfDay, startOfWeek } from '@/lib/block'
import { decimal } from '@/lib/format'
import { DEFAULT_HR_MAX } from '@/lib/paces'
import {
  Button,
  Card,
  CardTitle,
  Chip,
  EmptyState,
  ErrorCard,
  Field,
  LoadingCard,
  TextInput,
  TextLink,
} from './ui'
import { clearCachedBlock } from '@/lib/net'
import { useBlock } from './useBlock'

/** Same UTC-as-wall-clock round trip every date field in this app uses. */
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

/** A real instant rather than a training day, so — like Dashboard's own `syncFmt` — it
 *  reads in the viewer's own zone rather than pinned to UTC. */
const stampFmt = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short' })

interface InviteRow {
  note: string | null
  expiresAt: number
  usedAt: number | null
  usedBy: string | null
}

function SettingsSkeleton() {
  return (
    <>
      <LoadingCard rows={2} hero={false} />
      <LoadingCard rows={3} hero={false} />
      <LoadingCard rows={2} hero={false} busy={false} />
    </>
  )
}

/**
 * Mints one link at a time and lists what has already gone out. Its own component, not a
 * section of `Settings`, because it owns a fetch loop (`GET /api/invites`) nothing else on
 * the page needs — `Settings` only decides *whether* to mount it, on `user.isAdmin`.
 *
 * The token is shown once, here, in full: the database only ever holds its hash, so this
 * card is the one chance to copy it. The clipboard write is attempted automatically and
 * guarded — Safari outside a secure context, or a denied permission, both throw — and the
 * link stays printed on screen either way, because a write that failed silently would leave
 * "mint a link" looking like it did nothing.
 */
function InvitesCard() {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mintedUrl, setMintedUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [invites, setInvites] = useState<InviteRow[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)

  async function loadInvites() {
    try {
      const response = await fetch('/api/invites')
      if (!response.ok) throw new Error(await errorMessage(response, 'No se pudieron cargar las invitaciones'))
      const body = (await response.json()) as { invites: InviteRow[] }
      setInvites(body.invites)
      setListError(null)
    } catch (cause) {
      setListError(cause instanceof Error ? cause.message : 'No se pudieron cargar las invitaciones')
    }
  }

  useEffect(() => {
    void loadInvites()
  }, [])

  async function copy(url: string) {
    try {
      await navigator.clipboard?.writeText(url)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  async function mint() {
    setBusy(true)
    setError(null)
    setCopied(false)
    try {
      const response = await fetch('/api/invites', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note: note.trim() || null }),
      })
      if (response.status === 401) {
        location.href = '/login'
        return
      }
      if (!response.ok) throw new Error(await errorMessage(response, 'No se pudo crear la invitación'))
      const body = (await response.json()) as { url: string; expiresAt: number }
      setMintedUrl(body.url)
      setNote('')
      void copy(body.url)
      void loadInvites()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se ha podido conectar. Vuelve a intentarlo.')
    }
    setBusy(false)
  }

  return (
    <Card className="fade-up">
      <CardTitle>Invitaciones</CardTitle>
      <Field label="Nota (opcional)">
        <TextInput
          value={note}
          placeholder="Para Marc"
          onChange={(e) => {
            setNote(e.target.value)
            setCopied(false)
          }}
        />
      </Field>
      <Button variant="primary" className="mt-3 w-full" disabled={busy} onClick={() => void mint()}>
        {busy ? 'Creando…' : 'Crear invitación'}
      </Button>
      {error ? (
        <p role="alert" className="mt-2 text-caption leading-relaxed text-red">
          {error}
        </p>
      ) : null}

      {mintedUrl ? (
        <div className="mt-3 rounded-xl border border-line bg-surface-deep/30 px-3 py-2.5">
          <p className="break-all text-caption tabular-nums text-label-2">{mintedUrl}</p>
          <TextLink inset onClick={() => void copy(mintedUrl)}>
            {copied ? 'Copiado' : 'Copiar enlace'}
          </TextLink>
        </div>
      ) : null}

      <div className="mt-3 border-t border-line pt-2.5">
        {listError ? (
          <p role="alert" className="text-caption leading-relaxed text-red">
            {listError}
          </p>
        ) : invites == null ? (
          <p className="text-caption text-label-3">Cargando…</p>
        ) : invites.length === 0 ? (
          <p className="text-caption text-label-3">Todavía no has enviado ninguna.</p>
        ) : (
          <ul className="space-y-2">
            {invites.map((invite, i) => {
              const status =
                invite.usedAt != null ? 'used' : invite.expiresAt < Date.now() ? 'expired' : 'pending'
              return (
                <li key={i} className="flex items-center justify-between gap-2">
                  <span className="truncate text-caption text-label-2">{invite.note ?? 'Sin nota'}</span>
                  <Chip tone={status === 'used' ? 'done' : status === 'expired' ? 'down' : 'neutral'}>
                    {status === 'used'
                      ? `Usada el ${stampFmt.format(new Date(invite.usedAt!))}`
                      : status === 'expired'
                        ? 'Caducada'
                        : `Caduca el ${stampFmt.format(new Date(invite.expiresAt))}`}
                  </Chip>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Card>
  )
}

/**
 * `/ajustes` — the one screen every athlete but the owner also reaches, and the owner's
 * only way to mint invitations. Read once, top to bottom, it is every question `/bienvenida`
 * does not keep asking: who you are, how hard your zones are calibrated,
 * what your block is chasing, whether Strava is still talking to it, and the door out.
 *
 * The profile and block forms each sync from `/api/data` exactly once (`profileSynced`,
 * `blockSynced`), not on every payload: `reload()` fires from three unrelated places on
 * this page (a profile save, a Strava disconnect, a fresh invite), and re-seeding these
 * fields on every one of them would overwrite whatever the athlete is mid-typing in a
 * *different* card.
 */
/**
 * The athlete's MCP credential.
 *
 * Shown exactly once, at mint time, and never again: the server keeps only `sha256(token)`,
 * so there is nothing to re-display and losing it means minting another. The copy is a
 * `<code>` block rather than an input because it is read once and pasted once, and an
 * input invites the browser to offer to save it as a password.
 *
 * The warning under it is not decoration. This token is full read/write on one athlete's
 * training data, in plain text, inside an agent's config file — the athlete should know
 * that before they paste it somewhere shared.
 */
function McpCard({ hasToken, onChanged }: { hasToken: boolean; onChanged: () => void }) {
  const [token, setToken] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  async function mint() {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/mcp-token', { method: 'POST' })
      if (!response.ok) throw new Error(await errorMessage(response, 'No se pudo crear el token'))
      const body = (await response.json()) as { token: string }
      setToken(body.token)
      setCopied(false)
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo crear el token')
    }
    setBusy(false)
  }

  async function revoke() {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/mcp-token', { method: 'DELETE' })
      if (!response.ok) throw new Error(await errorMessage(response, 'No se pudo revocar el token'))
      setToken(null)
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo revocar el token')
    }
    setBusy(false)
  }

  return (
    <Card className="fade-up">
      <CardTitle>Agente (MCP)</CardTitle>
      <p className="text-footnote leading-relaxed text-label-2">
        Conecta un agente a tu bloque para que escriba el plan por ti. Necesita un token
        propio, distinto de tu contraseña.
      </p>

      {token ? (
        <>
          <code className="mt-3 block break-all rounded-xl bg-fill px-3 py-2.5 text-caption text-label">
            {token}
          </code>
          <p role="status" className="mt-2 text-caption leading-relaxed text-amber">
            Cópialo ahora: no vuelve a mostrarse. Da acceso completo a tu entrenamiento.
          </p>
          <Button
            className="mt-2.5 w-full"
            onClick={() => {
              void navigator.clipboard?.writeText(token).then(
                () => setCopied(true),
                () => setCopied(false),
              )
            }}
          >
            {copied ? 'Copiado' : 'Copiar token'}
          </Button>
        </>
      ) : null}

      {error ? (
        <p role="alert" className="mt-2 text-footnote leading-relaxed text-red">
          {error}
        </p>
      ) : null}

      <div className="mt-3 flex gap-2">
        <Button
          variant={hasToken ? 'ghost' : 'primary'}
          className="flex-1"
          disabled={busy}
          onClick={() => void mint()}
        >
          {busy ? 'Un momento…' : hasToken ? 'Generar uno nuevo' : 'Crear token'}
        </Button>
        {hasToken ? (
          <Button variant="ghost" className="flex-1" disabled={busy} onClick={() => void revoke()}>
            Revocar
          </Button>
        ) : null}
      </div>
    </Card>
  )
}

export function Settings() {
  const { data, error, reload } = useBlock()

  const [displayName, setDisplayName] = useState('')
  const [hrMax, setHrMax] = useState('')
  const [profileSynced, setProfileSynced] = useState(false)
  const [profileBusy, setProfileBusy] = useState(false)
  const [profileError, setProfileError] = useState<string | null>(null)
  const [profileSaved, setProfileSaved] = useState(false)

  const [raceName, setRaceName] = useState('')
  const [raceDate, setRaceDate] = useState('')
  const [goalTime, setGoalTime] = useState('')
  const [blockStart, setBlockStart] = useState('')
  const [blockSynced, setBlockSynced] = useState(false)
  const [blockBusy, setBlockBusy] = useState(false)
  const [blockError, setBlockError] = useState<string | null>(null)
  const [blockSaved, setBlockSaved] = useState(false)

  const [disconnectArmed, setDisconnectArmed] = useState(false)
  const [disconnectBusy, setDisconnectBusy] = useState(false)
  const [disconnectError, setDisconnectError] = useState<string | null>(null)

  useEffect(() => {
    if (data && !profileSynced) {
      setDisplayName(data.user.displayName)
      setHrMax(data.user.hrMax != null ? String(data.user.hrMax) : '')
      setProfileSynced(true)
    }
  }, [data, profileSynced])

  useEffect(() => {
    if (data?.block && !blockSynced) {
      setRaceName(data.block.raceName)
      setRaceDate(toDateInput(data.block.raceOn))
      setGoalTime(formatClock(data.block.goalTimeS))
      setBlockStart(toDateInput(data.block.startsOn))
      setBlockSynced(true)
    }
  }, [data, blockSynced])

  if (error && !data)
    return <ErrorCard title="Sin datos" message={error} onRetry={() => void reload()} />
  if (!data) return <SettingsSkeleton />

  async function saveProfile() {
    const name = displayName.trim()
    if (!name) {
      setProfileError('Escribe tu nombre.')
      document.getElementById('stg-name')?.focus()
      return
    }
    let hrValue: number | null = null
    if (hrMax.trim() !== '') {
      const n = Number(hrMax.trim())
      if (!Number.isInteger(n) || n < 120 || n > 230) {
        setProfileError('La FC máxima tiene que estar entre 120 y 230 lpm.')
        document.getElementById('stg-hr')?.focus()
        return
      }
      hrValue = n
    }

    setProfileBusy(true)
    setProfileError(null)
    try {
      const response = await fetch('/api/profile', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: name, hrMax: hrValue }),
      })
      if (response.status === 401) {
        location.href = '/login'
        return
      }
      if (!response.ok) throw new Error(await errorMessage(response, 'No se pudo guardar'))
      await reload()
      setProfileSaved(true)
    } catch (cause) {
      setProfileError(cause instanceof Error ? cause.message : 'No se ha podido conectar. Vuelve a intentarlo.')
    }
    setProfileBusy(false)
  }

  async function saveBlock() {
    // `data?.` rather than `data.`: this is a hoisted declaration, created before the
    // `if (!data)` guard above runs, so the narrowing there does not reach inside it.
    const currentBlock = data?.block
    if (!currentBlock) return
    if (!raceName.trim()) {
      setBlockError('Escribe el nombre de la carrera.')
      document.getElementById('stg-race-name')?.focus()
      return
    }
    const raceOn = fromDateInput(raceDate)
    if (raceOn == null) {
      setBlockError('Elige la fecha de la carrera.')
      document.getElementById('stg-race-date')?.focus()
      return
    }
    const goalTimeS = parseClock(goalTime)
    if (goalTimeS == null || goalTimeS <= 0) {
      setBlockError('El objetivo tiene que ir en formato 1:19:59.')
      document.getElementById('stg-goal-time')?.focus()
      return
    }
    const startsOnRaw = fromDateInput(blockStart)
    if (startsOnRaw == null) {
      setBlockError('Elige cuándo empieza el bloque.')
      document.getElementById('stg-block-start')?.focus()
      return
    }
    const startsOn = startOfWeek(startsOnRaw)
    const weeks = Math.ceil((startOfDay(raceOn) - startsOn) / WEEK_MS)
    if (weeks < MIN_BLOCK_WEEKS || weeks > MAX_BLOCK_WEEKS) {
      setBlockError(
        `Con esas fechas el bloque dura ${weeks} semanas: tiene que estar entre ${MIN_BLOCK_WEEKS} y ${MAX_BLOCK_WEEKS}.`,
      )
      document.getElementById('stg-race-date')?.focus()
      return
    }

    setBlockBusy(true)
    setBlockError(null)
    try {
      const response = await fetch('/api/profile', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          block: {
            startsOn,
            raceOn,
            goalTimeS,
            raceDistanceM: currentBlock.raceDistanceM,
            raceName: raceName.trim(),
          },
        }),
      })
      if (response.status === 401) {
        location.href = '/login'
        return
      }
      if (!response.ok) throw new Error(await errorMessage(response, 'No se pudo guardar'))
      await reload()
      setBlockSaved(true)
    } catch (cause) {
      setBlockError(cause instanceof Error ? cause.message : 'No se ha podido conectar. Vuelve a intentarlo.')
    }
    setBlockBusy(false)
  }

  async function disconnectStrava() {
    setDisconnectBusy(true)
    setDisconnectError(null)
    try {
      const response = await fetch('/api/strava/connect', { method: 'DELETE' })
      if (response.status === 401) {
        location.href = '/login'
        return
      }
      if (!response.ok) throw new Error(await errorMessage(response, 'No se pudo desconectar'))
      await reload()
      // Only on success: a failed attempt keeps the confirm armed, so a retry after a
      // dropped connection is one tap rather than "are you sure" a second time.
      setDisconnectArmed(false)
    } catch (cause) {
      setDisconnectError(cause instanceof Error ? cause.message : 'No se ha podido conectar. Vuelve a intentarlo.')
    }
    setDisconnectBusy(false)
  }

  async function signOut() {
    await fetch('/api/login', { method: 'DELETE' }).catch(() => {})
    // Before the redirect, not after: the cached block is this athlete's and the device is
    // about to stop being theirs. See `clearCachedBlock`.
    await clearCachedBlock()
    location.href = '/login'
  }

  const athleteName = [data.athlete?.firstname, data.athlete?.lastname].filter(Boolean).join(' ')

  return (
    <>
      <Card className="fade-up">
        <CardTitle>Perfil</CardTitle>
        <Field label="Nombre">
          <TextInput
            id="stg-name"
            value={displayName}
            onChange={(e) => {
              setDisplayName(e.target.value)
              setProfileSaved(false)
              setProfileError(null)
            }}
          />
        </Field>
        <div className="mt-3">
          <Field label="FC máxima (lpm)">
            <TextInput
              id="stg-hr"
              inputMode="numeric"
              placeholder={String(DEFAULT_HR_MAX)}
              value={hrMax}
              onChange={(e) => {
                setHrMax(e.target.value)
                setProfileSaved(false)
                setProfileError(null)
              }}
            />
          </Field>
          <p className="mt-2 text-caption leading-relaxed text-label-3">
            Las cinco zonas son un reparto de este número. Vacío usa {DEFAULT_HR_MAX} lpm.
          </p>
        </div>
        {profileError ? (
          <p role="alert" className="mt-2 text-caption leading-relaxed text-red">
            {profileError}
          </p>
        ) : profileSaved ? (
          <p className="mt-2 text-caption text-mint">Guardado.</p>
        ) : null}
        <Button variant="primary" className="mt-3 w-full" disabled={profileBusy} onClick={() => void saveProfile()}>
          {profileBusy ? 'Guardando…' : 'Guardar'}
        </Button>
      </Card>

      <Card className="fade-up">
        <CardTitle>Bloque y objetivo</CardTitle>
        {!data.block ? (
          <EmptyState action={<TextLink href="/bienvenida" tone="primary">Configurar ahora</TextLink>}>
            Todavía no has guardado tu carrera ni tus fechas.
          </EmptyState>
        ) : (
          <>
            <Field label="Nombre de la carrera">
              <TextInput
                id="stg-race-name"
                value={raceName}
                onChange={(e) => {
                  setRaceName(e.target.value)
                  setBlockSaved(false)
                  setBlockError(null)
                }}
              />
            </Field>
            <p className="mt-1.5 text-caption text-label-3">
              Distancia: {decimal(data.block.raceDistanceM / 1000)} km
            </p>

            <div className="mt-3">
              <Field label="Fecha de la carrera">
                <TextInput
                  id="stg-race-date"
                  type="date"
                  value={raceDate}
                  onChange={(e) => {
                    setRaceDate(e.target.value)
                    setBlockSaved(false)
                    setBlockError(null)
                  }}
                />
              </Field>
            </div>

            <div className="mt-3">
              <Field label="Objetivo">
                <TextInput
                  id="stg-goal-time"
                  inputMode="numeric"
                  placeholder="1:19:59"
                  value={goalTime}
                  onChange={(e) => {
                    setGoalTime(e.target.value)
                    setBlockSaved(false)
                    setBlockError(null)
                  }}
                />
              </Field>
            </div>

            <div className="mt-3">
              <Field label="Empieza el bloque">
                <TextInput
                  id="stg-block-start"
                  type="date"
                  value={blockStart}
                  onChange={(e) => {
                    setBlockStart(e.target.value)
                    setBlockSaved(false)
                    setBlockError(null)
                  }}
                />
              </Field>
              <p className="mt-2 text-caption leading-relaxed text-label-3">
                Mover estas fechas no toca las sesiones ya creadas — si dejan de encajar, se
                arreglan desde «Regenerar plan».
              </p>
            </div>

            {blockError ? (
              <p role="alert" className="mt-2 text-caption leading-relaxed text-red">
                {blockError}
              </p>
            ) : blockSaved ? (
              <p className="mt-2 text-caption text-mint">Guardado.</p>
            ) : null}
            <Button variant="primary" className="mt-3 w-full" disabled={blockBusy} onClick={() => void saveBlock()}>
              {blockBusy ? 'Guardando…' : 'Guardar'}
            </Button>
          </>
        )}
      </Card>

      <Card className="fade-up">
        <CardTitle>Plan</CardTitle>
        <p className="text-footnote leading-relaxed text-label-2">
          {data.hasPlan
            ? 'Edítalo semana a semana, o pídeselo a un agente conectado por MCP.'
            : 'Todavía no has escrito ninguna sesión. Puedes hacerlo a mano o con un agente.'}
        </p>
        <Button href="/plan" variant={data.hasPlan ? 'ghost' : 'primary'} className="mt-3 w-full">
          {data.hasPlan ? 'Ver el plan' : 'Escribir el plan'}
        </Button>
      </Card>

      <McpCard hasToken={data.user.hasMcpToken} onChanged={() => void reload()} />

      <Card className="fade-up">
        <CardTitle>Strava</CardTitle>
        {data.stravaConnected ? (
          <>
            <p className="text-footnote leading-relaxed text-label-2">
              Conectado{athleteName ? ` como ${athleteName}` : ''}.
            </p>
            <p className="mt-1 text-caption text-label-3">
              {data.lastSyncAt
                ? `Sincronizado el ${stampFmt.format(new Date(data.lastSyncAt))}`
                : 'Sin sincronizar todavía'}
            </p>
            {disconnectError ? (
              <p role="alert" className="mt-2 text-caption leading-relaxed text-red">
                {disconnectError}
              </p>
            ) : null}
            <Button
              variant={disconnectArmed ? 'danger' : 'ghost'}
              className="mt-3 w-full"
              disabled={disconnectBusy}
              onClick={() => (disconnectArmed ? void disconnectStrava() : setDisconnectArmed(true))}
            >
              {disconnectBusy ? 'Desconectando…' : disconnectArmed ? 'Confirmar desconexión' : 'Desconectar Strava'}
            </Button>
            {disconnectArmed ? (
              <p className="mt-1.5 text-caption leading-relaxed text-label-3">
                Las salidas ya sincronizadas se quedan — es solo la credencial.
              </p>
            ) : null}
          </>
        ) : (
          <EmptyState
            action={
              // Strava's own orange, the one hex outside the token file — their brand
              // guidelines own this button, and `text-ink` is the token that reads as the
              // white on it.
              <a
                href="/api/strava/connect"
                className="tappable inline-flex h-11 items-center justify-center rounded-xl bg-[#fc4c02] px-5 text-footnote font-semibold text-ink"
              >
                Conectar con Strava
              </a>
            }
          >
            Sin conectar. Hace falta para traer tus salidas y calcular el volumen.
          </EmptyState>
        )}
      </Card>

      {data.user.isAdmin ? <InvitesCard /> : null}

      <Card className="fade-up">
        <CardTitle>Cuenta</CardTitle>
        <p className="text-footnote leading-relaxed text-label-2">{data.user.email}</p>
        <Button variant="danger" className="mt-3 w-full" onClick={() => void signOut()}>
          Cerrar sesión
        </Button>
      </Card>
    </>
  )
}
