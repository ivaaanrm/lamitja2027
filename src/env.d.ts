/// <reference types="astro/client" />
/// <reference types="../worker-configuration.d.ts" />
// Declares `App.Locals` as the adapter's `Runtime` — this is what types
// `Astro.locals.cfContext` (the ExecutionContext, for `waitUntil`).
/// <reference types="@astrojs/cloudflare/types.d.ts" />

// Merged onto that declaration, and deliberately without `cfContext`: the adapter already
// declares it as required, and a second, optional copy of the same member is an error.
declare namespace App {
  interface Locals {
    /**
     * Resolved from the session cookie by `src/middleware.ts`. Absent on a public route
     * and never absent on a gated one — the middleware 401s before the route runs.
     */
    user?: import('./lib/auth').SessionUser
  }
}
