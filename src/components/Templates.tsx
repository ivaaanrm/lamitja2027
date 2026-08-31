import { BUILTIN_TEMPLATES, type TemplateContent } from '@/lib/starters'
import { strengthSummary } from '@/lib/strength'
import { RepdbAttribution } from './exercise-ui'
import { island } from './Island'
import { useBlock } from './useBlock'
import { CHEVRON_RIGHT, Button, Card, CardTitle, EmptyState, ErrorCard, Icon, LoadingCard } from './ui'

/**
 * The strength library: what you have written, and what the app ships with.
 *
 * A template is a Fuerza session written once and stamped onto a Monday for eleven weeks —
 * the one thing this app was genuinely bad at, since the alternative was typing nine moves
 * into a form every week. It carries no date, which is exactly what separates it from a
 * plan session, and applying one **copies** its content onto the day: revising a template
 * in November must not be able to rewrite the Monday you already trained in September.
 *
 * Two groups, own first. The two below them are compiled into the bundle
 * (`src/lib/starters.ts`) rather than seeded into anyone's database — the same category
 * `baseline.ts` is in: frozen content read out of code, identical for everybody, with no
 * per-user copy that can drift. That is why they are here on day one, before a single row
 * exists, and why the empty state above them is one sentence rather than a whole screen:
 * there is already something to read and something to duplicate.
 */
function TemplatesScreen() {
  const { data, error, reload } = useBlock()

  if (error && !data)
    return <ErrorCard title="Sin datos del bloque" message={error} onRetry={() => void reload()} />
  if (!data) return <LoadingCard rows={4} />

  const own = data.templates

  return (
    <>
      <Card className="fade-up">
        <CardTitle>Tuyas</CardTitle>
        {own.length === 0 ? (
          <EmptyState
            action={
              <Button variant="primary" href="/plantilla">
                Nueva plantilla
              </Button>
            }
          >
            Una plantilla es una sesión de fuerza que escribes una vez y aplicas cada
            semana. Empieza duplicando una de abajo, o escribe la tuya.
          </EmptyState>
        ) : (
          <>
            <ul className="-my-1 divide-y divide-line">
              {own.map((template) => (
                <TemplateRow key={template.id} template={template} />
              ))}
            </ul>
            <Button variant="primary" href="/plantilla" className="mt-3 w-full">
              Nueva plantilla
            </Button>
          </>
        )}
      </Card>

      <Card className="fade-up">
        <CardTitle>De Treximo</CardTitle>
        <ul className="-my-1 divide-y divide-line">
          {BUILTIN_TEMPLATES.map((template) => (
            <TemplateRow key={template.id} template={template} />
          ))}
        </ul>
        <p className="mt-2 border-t border-line pt-2 text-caption leading-relaxed text-label-3">
          Vienen con la app y no se editan. Duplica la que te sirva y cámbiala a tu gusto.
        </p>
      </Card>

      {/* Rendered unconditionally: RepDB's licence asks for visible attribution wherever
          the catalogue is in use, and that is about the library existing rather than about
          any particular template being open. */}
      <RepdbAttribution />
    </>
  )
}

/** One template as a row: what it is called, and what it costs. The whole row is the tap. */
function TemplateRow({ template }: { template: TemplateContent }) {
  return (
    <li>
      <a
        href={`/plantilla?id=${encodeURIComponent(template.id)}`}
        className="tappable flex min-h-11 items-center gap-2 py-2"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-subhead font-medium text-label">
            {template.name}
          </span>
          <span className="mt-0.5 block text-caption tabular-nums text-label-3">
            {strengthSummary(template.exercises, template.targetDurationS)}
          </span>
        </span>
        <Icon path={CHEVRON_RIGHT} strokeWidth={2.5} className="size-3 shrink-0 text-label-4" />
      </a>
    </li>
  )
}

/**
 * Wrapped so a render that throws leaves a card with a way out on it rather than an empty
 * column under the heading. See `Island.tsx`.
 */
export const Templates = island(TemplatesScreen)
