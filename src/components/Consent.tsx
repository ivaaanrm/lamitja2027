import { useEffect, useState } from 'react'
import { Button } from './ui'

/** What `GET /api/oauth/consent` describes — `clientIdentity` in `oauth/clients.ts`. */
interface Pending {
  client: {
    name: string
    host: string
    redirectHost: string
    verified: boolean
    loopback: boolean
  }
  user: { displayName: string; email: string }
  hasBlock: boolean
}

type State =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string; detail?: string }
  | { kind: 'ready'; pending: Pending; busy: 'approve' | 'deny' | null; error: string | null }

/**
 * Why `/oauth/authorize` sent the browser here instead of to the client. Both are failures
 * the client's developer has to fix, so the sentence is for the athlete — what happened and
 * that it is not their doing — and the English line under it is for whoever they forward
 * it to.
 *
 * Both are fixed strings keyed by the code, never text read out of the URL: a page that
 * printed its own query string would let anybody put words on this domain, under this
 * app's mark. The exact reason — which URL answered what — is in the Worker's log.
 */
const STOPPED: Record<string, { message: string; detail: string }> = {
  client: {
    message: 'La aplicación que intenta conectarse no se ha podido identificar.',
    detail:
      'The client_id could not be resolved: use an https URL serving a client metadata document, or register at /oauth/register.',
  },
  redirect: {
    message: 'La aplicación ha pedido volver a una dirección que no es la suya, así que la conexión se ha detenido.',
    detail: 'redirect_uri is missing, or is not one of the redirect URIs registered for this client.',
  },
}

/**
 * The consent screen: the one moment an athlete hands a third party the keys to their
 * training log, so it says exactly who, what and where — and nothing else.
 *
 * *Who* leads with the host that was actually verified (the domain a metadata document is
 * served from), never with the name the client gave itself, because anybody can call
 * themselves «Claude». A client that registered dynamically has nothing verified about it,
 * and the screen says so instead of dressing its name up as a fact. *Where* is the host the
 * browser will be sent back to, which the MCP spec asks a consent screen to show, with a
 * warning when it is this computer: any program on it could be listening on that port.
 *
 * The request itself is the sealed `req` in the URL, read inside an effect because this
 * island is also rendered at build time, where `location` does not exist (gotcha 15). A
 * `401` from the description is the athlete not being signed in yet: they go to `/login`
 * and come back to this exact URL, request and all.
 *
 * It refuses to run inside a frame. A one-tap «Permitir» is the textbook clickjacking
 * target, and the `_headers` rule that forbids framing this page is the real defence; this
 * is the same check made by the page itself, for whatever serves it without the header.
 */
export function Consent({ appName }: { appName: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [sealed, setSealed] = useState('')

  useEffect(() => {
    if (window.top !== window.self) {
      setState({ kind: 'failed', message: 'Esta página no puede abrirse dentro de otra.' })
      return
    }

    const params = new URLSearchParams(location.search)
    const stopped = params.get('error')
    if (stopped) {
      setState({ kind: 'failed', ...(STOPPED[stopped] ?? { message: 'La solicitud de conexión no es válida.' }) })
      return
    }

    const req = params.get('req') ?? ''
    if (!req) {
      setState({ kind: 'failed', message: 'Este enlace no lleva ninguna solicitud. Vuelve a conectar desde la aplicación.' })
      return
    }
    setSealed(req)

    void (async () => {
      try {
        const response = await fetch(`/api/oauth/consent?req=${encodeURIComponent(req)}`)
        if (response.status === 401) {
          // A document load: `/login` sets the cookie and then sends the browser on to `next`.
          location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`
          return
        }
        const body = (await response.json().catch(() => null)) as (Pending & { error?: string }) | null
        if (!response.ok || !body) {
          setState({ kind: 'failed', message: body?.error ?? 'No se ha podido leer la solicitud.' })
          return
        }
        setState({ kind: 'ready', pending: body, busy: null, error: null })
      } catch {
        setState({ kind: 'failed', message: 'No se ha podido conectar. Vuelve a intentarlo.' })
      }
    })()
  }, [])

  async function decide(approve: boolean) {
    if (state.kind !== 'ready') return
    setState({ ...state, busy: approve ? 'approve' : 'deny', error: null })
    try {
      const response = await fetch('/api/oauth/consent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ req: sealed, approve }),
      })
      const body = (await response.json().catch(() => null)) as { redirect?: string; error?: string } | null
      if (response.ok && body?.redirect) {
        // Left busy on purpose: the page is on its way out, and flicking the button back to
        // its idle label would read as the answer not having been taken.
        location.href = body.redirect
        return
      }
      setState({ ...state, busy: null, error: body?.error ?? 'No se ha podido completar. Vuelve a intentarlo.' })
    } catch {
      setState({ ...state, busy: null, error: 'No se ha podido conectar. Vuelve a intentarlo.' })
    }
  }

  if (state.kind === 'loading') {
    // The heading's footprint, so the card does not jump when the description arrives.
    return (
      <div aria-busy="true" className="fade-up">
        <p className="mt-5 text-caption2 font-semibold uppercase tracking-[0.16em] text-label-3">
          Conectar una aplicación
        </p>
        <div className="mt-2 h-8 w-2/3 rounded-lg bg-fill" />
        <div className="mt-3 h-4 w-full rounded bg-fill" />
      </div>
    )
  }

  if (state.kind === 'failed') {
    return (
      <div className="fade-up">
        <p className="mt-5 text-caption2 font-semibold uppercase tracking-[0.16em] text-label-3">
          Conectar una aplicación
        </p>
        <h1 className="mt-2 font-display text-title2 font-bold tracking-tight text-label">
          No se puede conectar
        </h1>
        <p role="alert" className="mt-3 text-footnote leading-relaxed text-label-2">
          {state.message}
        </p>
        {state.detail ? (
          <p className="mt-2 break-words text-caption leading-relaxed text-label-3">{state.detail}</p>
        ) : null}
        <Button href="/" className="mt-5 w-full">
          Ir a {appName}
        </Button>
      </div>
    )
  }

  const { client, user, hasBlock } = state.pending
  const named = client.name !== client.host

  return (
    <div className="fade-up">
      <p className="mt-5 text-caption2 font-semibold uppercase tracking-[0.16em] text-label-3">
        Conectar una aplicación
      </p>
      <h1 className="mt-2 break-words font-display text-title2 font-bold tracking-tight text-label">
        {client.host}
      </h1>
      <p className="mt-3 text-footnote leading-relaxed text-label-2">
        quiere acceder a tu entrenamiento en {appName}.
        {named ? (
          <>
            {' '}
            Se presenta como «{client.name}»
            {client.verified ? '.' : ', pero no hay forma de comprobar quién es.'}
          </>
        ) : client.verified ? null : ' No hay forma de comprobar quién es.'}
      </p>

      <div className="mt-5 rounded-2xl bg-fill p-4">
        <p className="text-caption2 font-semibold uppercase tracking-[0.12em] text-label-3">Podrá</p>
        <ul className="mt-1.5 flex flex-col gap-1 text-footnote leading-relaxed text-label">
          <li>Leer tu bloque, tu plan y las actividades sincronizadas de Strava.</li>
          <li>Crear, cambiar y borrar sesiones, semanas y plantillas.</li>
        </ul>
        <p className="mt-2.5 text-caption leading-relaxed text-label-2">
          No verá tu contraseña ni tu cuenta de Strava, ni el entrenamiento de nadie más. Puedes
          desconectarla cuando quieras desde Ajustes.
        </p>

        {client.loopback ? (
          <p className="mt-2.5 text-caption leading-relaxed text-amber">
            Volverá a {client.redirectHost}, es decir, a un programa de este ordenador. Acepta
            solo si acabas de conectarlo tú.
          </p>
        ) : (
          <p className="mt-2.5 text-caption leading-relaxed text-label-2">
            Al aceptar volverás a <span className="text-label">{client.redirectHost}</span>.
          </p>
        )}

        {!hasBlock ? (
          <p role="alert" className="mt-2.5 text-footnote leading-relaxed text-red">
            Configura tu bloque antes de conectar una aplicación: sin él no hay semanas que leer.
          </p>
        ) : null}
        {state.error ? (
          <p role="alert" className="mt-2.5 text-footnote leading-relaxed text-red">
            {state.error}
          </p>
        ) : null}

        <div className="mt-3 flex gap-2">
          <Button
            variant="ghost"
            className="flex-1"
            disabled={state.busy !== null}
            onClick={() => void decide(false)}
          >
            {state.busy === 'deny' ? 'Cancelando…' : 'Cancelar'}
          </Button>
          <Button
            variant="primary"
            className="flex-1"
            disabled={state.busy !== null || !hasBlock}
            onClick={() => void decide(true)}
          >
            {state.busy === 'approve' ? 'Conectando…' : 'Permitir'}
          </Button>
        </div>
      </div>

      <p className="mt-3 text-center text-caption text-label-3">
        Has entrado como {user.displayName} · {user.email}
      </p>
    </div>
  )
}
