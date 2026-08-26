import { Component, type ComponentType, type ReactNode } from 'react'
import { bootDone } from '@/lib/boot'
import { Button, Card, CardTitle, EmptyState } from './ui'

/**
 * What every screen in this app is wrapped in, and the only reason it exists is the shape
 * of a failure without it.
 *
 * React unmounts the whole tree when a render throws, and every page here is a single
 * island under a prerendered shell — so one bad number is not a broken card, it is an
 * empty `<main>`. The launch screen hides that for 2.6 seconds and then the dead-man
 * switch drops it, and what the athlete is left holding is a page with a heading, a dock
 * and nothing between them: an app that looks like it opened and forgot to.
 *
 * The screens are also where that risk actually lives. Everything they draw is derived on
 * the client from two sources nobody here controls — Strava's record and a hand-edited
 * plan — and the derivations are arithmetic over optional fields. `ErrorCard` already
 * covers the failure that *is* expected (the fetch that did not come back); this covers
 * the one that is not.
 *
 * It reports the same way the rest of the app reports trouble: a card, in Spanish, with a
 * way out on it. The way out is a reload rather than a retry, because a component that
 * threw on this render will throw on the next one from the same state — the state has to
 * go, and on a screen with no local state worth keeping, that is the document.
 *
 * `bootDone()` on the way in for the same reason it is called on a failed fetch: a screen
 * you can act on must never stay hidden behind the mark.
 */
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown) {
    bootDone()
    // The one place in the app that logs: a crash on a phone leaves no other trace, and
    // Safari's inspector over USB is how this would ever be looked at.
    console.error('[la mitja] la pantalla ha fallado', error)
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <Card className="fade-up">
        <CardTitle>Algo se ha roto</CardTitle>
        <EmptyState
          action={
            <Button variant="primary" onClick={() => location.reload()}>
              Recargar
            </Button>
          }
        >
          <span role="alert" className="text-red">
            Esta pantalla no se ha podido dibujar.
          </span>{' '}
          No se ha perdido nada: el bloque está en el servidor y se vuelve a leer entero al
          recargar.
        </EmptyState>
      </Card>
    )
  }
}

/**
 * Wraps a screen in the boundary above, keeping its name so React's own stack traces and
 * the devtools tree still say which one it was.
 */
export function island<P extends object>(Screen: ComponentType<P>): ComponentType<P> {
  const Wrapped = (props: P) => (
    <Boundary>
      <Screen {...props} />
    </Boundary>
  )
  Wrapped.displayName = Screen.displayName ?? Screen.name
  return Wrapped
}
