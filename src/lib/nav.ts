/**
 * The four places this app goes.
 *
 * One list, read by the dock and by every page that has to say which tab it is — a page
 * whose `tab` does not match a real entry is a type error rather than a dock with nothing
 * lit up.
 */
export const TABS = [
  { key: 'today', href: '/', label: 'Hoy' },
  { key: 'plan', href: '/plan', label: 'Plan' },
  { key: 'progress', href: '/progreso', label: 'Progreso' },
  { key: 'log', href: '/registro', label: 'Registro' },
] as const

export type Tab = (typeof TABS)[number]['key']
