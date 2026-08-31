import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

/** What the keyboard leaves of the screen: how tall it still is, and how much of the
 *  bottom edge is covered. Null until the first measurement, and on any browser without
 *  a `visualViewport`. */
interface Viewport {
  height: number
  inset: number
}

/**
 * The app's modal, in one place.
 *
 * There are two of them now — the session editor and the exercise picker — and everything
 * below was tuned once, on a phone, for the first. Written out twice they would drift a
 * radius and a keyboard fix apart, and the keyboard fix is the half nobody would notice
 * had gone: it only shows up on a real device with a real software keyboard, which is
 * exactly the case a second copy never gets tested against.
 *
 * **The rise.** The panel travels its own height up from the bottom edge and the scrim
 * fades in behind it; they are separate elements precisely so the scrim never travels
 * with it.
 *
 * **Three bands: a pinned grabber and title, a scrolling body, and a pinned action bar.**
 * The bar is pinned rather than sitting at the end of the form because a sheet whose
 * Guardar button is below the fold is a sheet that looks like it cannot be saved, and on a
 * phone the fold moves every time the keyboard opens.
 *
 * **`visualViewport`, because iOS does not shrink the layout viewport.** `100vh`, `100dvh`
 * and a `fixed inset-0` scrim all keep describing the whole screen when the keyboard comes
 * up, so a sheet anchored to the bottom edge keeps its action bar under the keys.
 * `visualViewport` is the only surface that reports the covered strip: the panel is lifted
 * clear of it and capped to whatever height is left. Read in an effect and never in the
 * component body — this island is also rendered during prerender, inside a Worker where
 * there is no `window` at all (AGENTS gotcha 15).
 */
export function Sheet({
  title,
  busy = false,
  onClose,
  footer,
  children,
}: {
  /** Spanish, and the sheet's accessible name. */
  title: string
  /** Blocks Escape and the scrim while a write is in flight. */
  busy?: boolean
  onClose: () => void
  /** The pinned bar. Actions, or whatever the sheet has to keep on screen. */
  footer?: ReactNode
  /** The scrolling body. */
  children: ReactNode
}) {
  const [viewport, setViewport] = useState<Viewport | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()

  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const measure = () =>
      setViewport({
        height: vv.height,
        inset: Math.max(0, window.innerHeight - vv.height - vv.offsetTop),
      })
    measure()
    vv.addEventListener('resize', measure)
    vv.addEventListener('scroll', measure)
    return () => {
      vv.removeEventListener('resize', measure)
      vv.removeEventListener('scroll', measure)
    }
  }, [])

  useEffect(() => {
    // Focus goes to the panel, not to the first field: an autofocused input opens the
    // keyboard before anyone has decided to type, and the sheet would arrive with half of
    // itself already covered. It also puts Escape and the tab order inside the dialog.
    panelRef.current?.focus()
  }, [])

  // With the keyboard down the sheet leaves a strip of scrim above it — that strip is the
  // tap target that dismisses it. With the keyboard up every remaining pixel is worth more
  // than the strip, so the cap opens out to the whole visible viewport.
  const maxHeight = viewport
    ? Math.round(viewport.height * (viewport.inset > 0 ? 1 : 0.88))
    : undefined

  return (
    <div
      className="fixed inset-0 z-50"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) onClose()
      }}
    >
      <button
        type="button"
        aria-label="Cerrar"
        onClick={() => !busy && onClose()}
        className="fade-in absolute inset-0 bg-surface-deep/80 backdrop-blur-sm"
      />

      <div
        className="absolute inset-x-0 bottom-0 flex justify-center"
        style={{ bottom: viewport?.inset ?? 0 }}
      >
        <div
          ref={panelRef}
          tabIndex={-1}
          aria-busy={busy}
          style={{ maxHeight }}
          className="sheet-rise performance-shadow flex max-h-[88dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border-t border-line bg-surface-raised outline-none"
        >
          {/* The inset is 20px rather than the 12px a card uses, so the controls sit where
              a card's contents sit optically: the page gutter is not under a sheet. */}
          <div className="shrink-0 px-5 pb-2.5 pt-2.5">
            <span aria-hidden className="mx-auto mb-3 block h-1 w-10 rounded-full bg-fill-strong" />
            <h2 id={titleId} className="font-display text-title3 font-bold tracking-tight">
              {title}
            </h2>
          </div>

          {/* `overscroll-contain` is what stops the drag from leaking: without it, flicking
              this list once it has hit its end scrolls the plan *behind* the sheet, so
              closing the sheet lands you somewhere else in a 23-week list than where you
              opened it. */}
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-5 pb-4">
            {children}
          </div>

          {footer ? (
            <div className="shrink-0 border-t border-line px-5 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3">
              {footer}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
