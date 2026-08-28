import { useEffect, useState } from 'react'
import { cn } from '@/lib/cn'
import { clearCachedBlock } from '@/lib/net'
import { Button, Field, TextInput } from './ui'

/** Which field a failed check points at; `null` when the problem is the invitation itself. */
type FieldName = 'name' | 'email' | 'password' | 'repeat' | null

/** One message for every way an invitation can fail, matching what `/api/register` says. */
const BAD_INVITE = 'Invitación no válida o ya usada'

/**
 * Accepting an invitation: the only way into the app that is not the owner's one-time
 * bootstrap.
 *
 * The token lives in the query string and is read **inside an effect**. This island is
 * also rendered at build time, in a Worker, where `location` does not exist — touching it
 * in the component body fails the build rather than the page (AGENTS.md gotcha 15).
 *
 * That is also why a missing token does not hide the form. The prerendered HTML is the
 * common case — someone who followed a real link — and swapping the whole card out on
 * mount would make every correct arrival flash. A link with no token instead lands its
 * complaint in the same error slot every other failure uses, before the first keystroke.
 *
 * The form checks exactly two things the server would only answer with a round trip: that
 * the fields are filled and that the two passwords match. Everything else — the length
 * rule, whether the address is already taken, whether the invitation is still alive — is
 * the server's answer, rendered as it comes back. An island's own checks spare a request;
 * they are never the rule.
 */
export function Register() {
  const [token, setToken] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [invalid, setInvalid] = useState<FieldName>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const value = new URLSearchParams(location.search).get('token') ?? ''
    setToken(value)
    if (!value) setError('Este enlace no lleva ninguna invitación. Pide una nueva.')
  }, [])

  function fail(message: string, field: FieldName) {
    setError(message)
    setInvalid(field)
    // Ids rather than a ref per input: four refs to serve the one call a failed submit
    // makes. `role="alert"` reads the sentence out; this puts the caret where it applies.
    if (field) document.getElementById(`register-${field}`)?.focus()
  }

  function clear() {
    setError(null)
    setInvalid(null)
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    clear()

    if (!token) return fail('Este enlace no lleva ninguna invitación. Pide una nueva.', null)
    if (!name.trim()) return fail('Escribe tu nombre.', 'name')
    if (!email.trim()) return fail('Escribe tu correo.', 'email')
    // The same floor `auth-input.ts` enforces, checked here only so the sentence arrives
    // before the request does.
    if (password.length < 10) {
      return fail('La contraseña debe tener al menos 10 caracteres.', 'password')
    }
    if (password !== repeat) return fail('Las contraseñas no coinciden.', 'repeat')

    setBusy(true)
    try {
      const response = await fetch('/api/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, email, password, displayName: name }),
      })
      if (response.ok) {
        // A document load, not a client-side navigation: the session cookie has just been
        // set and `/bienvenida` reads it on mount. `busy` stays true — the page is already
        // on its way out, and flicking the button back would read as the attempt failing.
        // Same reason as `/login`: a device may have been holding somebody else's block.
        await clearCachedBlock()
        location.href = '/bienvenida'
        return
      }

      const body = (await response.json().catch(() => null)) as { error?: string } | null
      // 409 is the only failure that points at a field: the address is taken, and the rest
      // of the form is fine. Everything else is about the invitation or the input as a
      // whole, so the server's sentence stands on its own.
      fail(body?.error ?? BAD_INVITE, response.status === 409 ? 'email' : null)
    } catch {
      // fetch only rejects on a transport failure, so this is "no hay red", never a 400.
      fail('No se ha podido conectar. Vuelve a intentarlo.', null)
    }
    setBusy(false)
  }

  /** Red rule paired with the sentence, so the state is never carried by colour alone. */
  const mark = (field: FieldName) => ({
    'aria-invalid': invalid === field,
    className: 'aria-[invalid=true]:border-red',
  })

  return (
    // The same shell `/login` wears — the two screens are the same moment in the product,
    // and a stranger arriving on either should not be able to tell they were built apart.
    <form
      noValidate
      onSubmit={submit}
      aria-busy={busy}
      className="fade-up rounded-2xl bg-fill p-4"
      style={{ animationDelay: '30ms' }}
    >
      {/* 44px controls rather than `/login`'s 48: four fields and a button, and 44 is the
          app's own control height everywhere else a form has more than one answer in it. */}
      <Field label="Nombre">
        <TextInput
          id="register-name"
          value={name}
          onChange={(event) => {
            setName(event.target.value)
            clear()
          }}
          autoComplete="name"
          enterKeyHint="next"
          aria-describedby="register-error"
          {...mark('name')}
        />
      </Field>

      <div className="mt-3">
        <Field label="Correo">
          {/* iOS capitalises the first letter of every field it is not told about, and the
              address is stored lowercased — `Marc@…` typed here is a row nobody has. */}
          <TextInput
            id="register-email"
            type="email"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value)
              clear()
            }}
            autoComplete="email"
            inputMode="email"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="next"
            aria-describedby="register-error"
            {...mark('email')}
          />
        </Field>
      </div>

      <div className="mt-3">
        <Field label="Contraseña">
          <TextInput
            id="register-password"
            type="password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value)
              clear()
            }}
            autoComplete="new-password"
            enterKeyHint="next"
            aria-describedby="register-hint register-error"
            {...mark('password')}
          />
        </Field>
        <p id="register-hint" className="mt-2 text-caption leading-relaxed text-label-3">
          Al menos 10 caracteres. No hay forma de recuperarla: si la pierdes, pide otra
          invitación.
        </p>
      </div>

      <div className="mt-3">
        <Field label="Repetir contraseña">
          <TextInput
            id="register-repeat"
            type="password"
            value={repeat}
            onChange={(event) => {
              setRepeat(event.target.value)
              clear()
            }}
            autoComplete="new-password"
            enterKeyHint="go"
            aria-describedby="register-error"
            {...mark('repeat')}
          />
        </Field>
      </div>

      {/* Above the button and below the fields, so the fix is next to the thing that needs
          fixing and the target the thumb is already over does not move. Hidden rather than
          unmounted: every field points at this id, and a live region announces a change to
          its own text far more reliably than it announces being inserted into the page. */}
      <p
        id="register-error"
        role="alert"
        className={cn('mt-2 text-footnote leading-relaxed text-red', !error && 'hidden')}
      >
        {error}
      </p>

      <Button type="submit" variant="primary" disabled={busy} className="mt-3 w-full">
        {busy ? 'Creando tu cuenta…' : 'Crear cuenta'}
      </Button>
    </form>
  )
}
