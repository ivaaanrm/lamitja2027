import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/**
 * Merge Tailwind classes so a caller's override actually wins over a component default —
 * taught this app's own `@theme` first, because otherwise it wins the wrong ones.
 *
 * tailwind-merge resolves a conflict by deciding which *group* a class belongs to, and it
 * knows only the stock scales. Every `text-*` name it does not recognise falls through to
 * `text-color`, so `text-caption2` and `text-label-3` looked to it like two colours fighting
 * over one slot and the size was quietly dropped — `cn('text-caption2', 'text-label-3')`
 * returned `text-label-3` and the label rendered at whatever it inherited. The whole ramp
 * is custom and so is every colour in the palette, so that hit *every* place a size and a
 * colour met, which is nearly every element in the app.
 *
 * So both lists are declared here. They are the `@theme` block in `global.css` and must be
 * kept in step with it: a token added there and not here is a token that starts silently
 * losing its size again. Two rules make that easier to hold on to — a name belongs to
 * exactly one of the two lists, and `text-<size>` and `text-<colour>` must never collide,
 * which is why `display` is a size (`text-display`, 34px) and the *family* is reached for
 * as `font-display`.
 */
const merge = extendTailwindMerge({
  extend: {
    classGroups: {
      // The one type ramp. `src/styles/global.css`, `--text-*`.
      'font-size': [
        {
          text: [
            'caption2',
            'caption',
            'footnote',
            'subhead',
            'body',
            'title3',
            'title2',
            'title1',
            'display',
          ],
        },
      ],
      // Every colour token that can ride on `text-`. `--color-*`, minus the ones that only
      // ever paint a background or a border.
      'text-color': [
        {
          text: [
            'ink',
            'surface',
            'surface-deep',
            'surface-raised',
            'label',
            'label-2',
            'label-3',
            'label-4',
            'lime',
            'green',
            'mint',
            'blue',
            'violet',
            'coral',
            'red',
            'amber',
          ],
        },
      ],
    },
  },
})

export const cn = (...inputs: ClassValue[]) => merge(clsx(inputs))
