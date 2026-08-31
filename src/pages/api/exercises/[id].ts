import type { APIRoute } from 'astro'
import { json } from '@/lib/api'
import { exerciseById } from '@/lib/exercises/catalog'

export const prerender = false

/**
 * One full catalogue record: the description, the numbered instructions, the tips, the
 * muscles and the poses — about a kilobyte, which is what the picker's expandable row and
 * the exercise detail sheet render.
 *
 * One at a time, by id, and only for a signed-in athlete (the middleware is default-closed
 * for `/api/*`). That is the shape licence term 3 asks for: the prose is reachable for the
 * move somebody is actually looking at, and there is no request that returns two.
 *
 * `/api/exercises/img/<version>/<id>/<pose>` is four segments deep and matches its own
 * route, not this one; a bare `/api/exercises/img` does land here, and answers the same
 * 404 any other unknown slug does.
 */
export const GET: APIRoute = ({ params }) => {
  const exercise = params.id ? exerciseById(params.id) : undefined
  if (!exercise) return json({ error: 'No existe ese ejercicio' }, 404)
  return json(exercise)
}
