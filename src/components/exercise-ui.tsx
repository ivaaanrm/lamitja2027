import { useState } from 'react'
import { cn } from '@/lib/cn'
import { exerciseImageUrl } from '@/lib/exercise-meta'
import { DUMBBELL, Icon } from './ui'

/**
 * The two things every catalogue-facing surface needs and none of them owns: the
 * illustration, and the line that says whose illustration it is.
 *
 * Four screens draw an exercise — the session card's breakdown, the session detail, the
 * template editor and the picker — and all four are in different files owned by different
 * concerns. Written out per screen, the tile would drift a radius and a fallback apart
 * four ways, which is the drift `ui/index.tsx` exists to stop. It is not in `ui/` because
 * it is not a shape the design system repeats: it knows the catalogue's URL scheme and the
 * licence's attribution requirement, neither of which a `Card` or a `Button` should.
 *
 * Nothing here imports `src/lib/exercises/` — that directory is ~650 KB of vendored prose
 * and is Worker-only (`test/unit/exercises.test.ts` enforces it). `exercise-meta.ts` is the
 * generated, browser-safe sliver: the generation stamp and the URL shape.
 */

/**
 * One exercise illustration, with the fallback painted underneath rather than swapped in.
 *
 * This is `AvatarFace`'s pattern and it is the same argument: the ground and the glyph are
 * always in the DOM at the tile's full size, and the photo lays over them when it arrives.
 * A tile that renders nothing until an image loads and then appears is a row that jumps;
 * a tile that swaps a fallback in on error is a row that jumps later.
 *
 * And the fallback carries real weight here, more than it does for an avatar. The images
 * are mirrored into R2 by an operator running `pnpm exercises:populate`, once, out of band
 * — so on a fresh deployment, on a fork that has not run it, and for any exercise a
 * re-vendored catalogue has added since, the URL is a genuine 404. The prescription is
 * legible without it: the name, the series and the cue are on the row beside this tile,
 * and the illustration was only ever the confirmation. `alt=""` for exactly that reason —
 * it is decorative, and a screen reader announcing the name twice is worse than silence.
 */
export function ExerciseThumb({
  exerciseId,
  className,
}: {
  /** `null` for a written-in move the catalogue does not have — a legitimate prescription. */
  exerciseId: string | null
  className?: string
}) {
  const [failed, setFailed] = useState(false)
  const src = exerciseId ? exerciseImageUrl(exerciseId) : null

  return (
    <span
      className={cn(
        'relative flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface-deep/60 text-label-4',
        className,
      )}
    >
      <Icon path={DUMBBELL} className="size-5" />
      {src && !failed ? (
        <img
          src={src}
          alt=""
          width={512}
          height={512}
          loading="lazy"
          decoding="async"
          className="absolute inset-0 size-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : null}
    </span>
  )
}

/**
 * «Datos de ejercicios por RepDB (repdb.co)» — a licence term, not a courtesy.
 *
 * RepDB's Free Tier v1.0 requires visible attribution wherever the data is shown, so this
 * is rendered unconditionally on both surfaces that show it: the library and the picker.
 * It is not gated on there being results, because the requirement is about the catalogue
 * being in use, not about a particular query answering.
 *
 * `rel="external"` is belt and braces — `router.tsx` already declines to swallow a click
 * whose origin is not this one — and `target="_blank"` is what an installed PWA needs:
 * following an outbound link in place is a one-way door out of an app with no address bar.
 */
export function RepdbAttribution({ className }: { className?: string }) {
  return (
    <p className={cn('px-1 text-caption2 leading-relaxed text-label-3', className)}>
      Datos de ejercicios por{' '}
      <a
        href="https://repdb.co"
        target="_blank"
        rel="external noreferrer"
        className="tappable inline-flex min-h-11 items-center underline underline-offset-4"
      >
        RepDB (repdb.co)
      </a>
    </p>
  )
}
