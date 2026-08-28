/**
 * Whether the software keyboard is covering the bottom of the screen.
 *
 * This exists because of the one thing `position: fixed` gets wrong on a phone. A fixed
 * element is laid out against the **layout** viewport, and the keyboard does not change
 * the layout viewport — it covers it. What shrinks is the **visual** viewport, the part
 * you can actually see. So a bar pinned to `bottom: 0` sits *behind* the keyboard, and
 * while iOS pans the visual viewport around to keep the focused field in sight, that bar
 * comes and goes across the middle of the screen: the dock "moving from its place", every
 * time a filter or a form field on `/plan`, `/ajustes` or a session sheet is tapped.
 *
 * Native iOS answers this by hiding the tab bar while the keyboard is up, and so does the
 * app now. `src/components/Dock.astro` owns the animation; this owns the one fact behind
 * it.
 *
 * **The flag lives on `<html>`, like `data-offline`, and for the same two reasons.** The
 * thing that knows the answer is not a component — it is the visual viewport — and
 * `ClientRouter` swaps the body on every tab tap and leaves the root alone, so a flag put
 * there survives a navigation without anything having to persist it. The dock then reads
 * it in CSS and costs no JavaScript of its own.
 *
 * Nothing here is iOS-specific, but iOS is what needs it: Chrome can be told to resize the
 * layout viewport instead (`interactive-widget=resizes-content`), and Safari has no such
 * switch.
 */
const FLAG = 'data-keyboard'

/**
 * Below this, the gap between the two viewports is browser chrome — Safari's toolbar
 * collapsing as the page scrolls — rather than a keyboard. The smallest iPhone keyboard is
 * around 216pt and the toolbar around 44, so anything in between is unambiguous.
 */
const KEYBOARD_MIN_PX = 120

/**
 * Starts watching. Called once per document from `src/layouts/Base.astro`, next to the
 * service worker registration, because both are document-scoped and both have to cover the
 * pages that carry no island at all.
 *
 * A no-op where `visualViewport` is missing: the flag simply never appears, and the dock
 * behaves exactly as it did before.
 */
export function watchKeyboard(): void {
  const viewport = typeof window === 'undefined' ? null : window.visualViewport
  if (!viewport) return

  let raised = false

  const sync = () => {
    /**
     * How much of the layout viewport the visual one no longer reaches at the bottom:
     * what the keyboard is covering, plus whatever iOS has panned past the top.
     * `clientHeight` and not `innerHeight` — the latter tracks the visual viewport on iOS,
     * which is the very thing being measured against.
     */
    const covered =
      document.documentElement.clientHeight - viewport.height - viewport.offsetTop
    // A pinch-zoomed page shrinks the visual viewport too, and hiding the dock there would
    // be answering a question nobody asked.
    const next = viewport.scale <= 1.01 && covered > KEYBOARD_MIN_PX
    // `scroll` fires on every frame iOS pans the visual viewport; writing the attribute
    // each time would invalidate style on all of them.
    if (next === raised) return
    raised = next
    document.documentElement.toggleAttribute(FLAG, raised)
  }

  // `resize` is the keyboard opening and closing; `scroll` is iOS sliding the visual
  // viewport up to reveal the field under it, which happens without a resize.
  viewport.addEventListener('resize', sync)
  viewport.addEventListener('scroll', sync)
  sync()
}
