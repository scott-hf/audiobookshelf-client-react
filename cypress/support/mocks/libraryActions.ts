// Cypress component-testing mock for src/app/actions/libraryActions.ts.
//
// That file is a `'use server'` Server Actions module and (transitively, via `@/lib/api`)
// has a top-level `import { cookies, headers } from 'next/headers'`. Real Next builds
// (`next build`/`next dev`) split a `'use server'` file into two compiled layers: the real
// server-side implementation, and a client-safe RPC stub that never actually bundles
// `next/headers` for the browser. Cypress's component-testing webpack bundle
// (`@cypress/webpack-dev-server`'s "next" framework preset) does not run that split -- it
// compiles the mounted tree as one plain client/Pages-Router bundle, so any component that
// transitively imports this file fails to even compile:
//   "You're importing a module that depends on next/headers... but you are using it in the
//   Pages Router."
// (Aliasing `next/headers` itself does NOT work around this: the check is a static-source
// scan of the literal `from 'next/headers'` import text in `src/lib/api.ts`, independent of
// webpack module resolution -- verified empirically before adding this alias instead.)
//
// This mock replaces the whole action module for the CT bundle only (see
// cypress.config.ts's `webpackConfig.resolve.alias`). No spec mounts a real
// `LibraryProvider` (the only thing that actually calls these), so every export below
// should never be invoked in a component test; each throws loudly if it is, so a future
// spec that legitimately needs one of these can `cy.stub()` it deliberately instead of
// silently getting fake data.
function unexpectedCall(name: string): never {
  throw new Error(`${name} was called in a Cypress component test via the mocked src/app/actions/libraryActions.ts -- stub it explicitly if this is intentional`)
}

export async function fetchLibraryItemsAction() {
  return unexpectedCall('fetchLibraryItemsAction')
}

export async function fetchLibraryFilterDataAction() {
  return unexpectedCall('fetchLibraryFilterDataAction')
}

export async function fetchLibraryPersonalizedAction() {
  return unexpectedCall('fetchLibraryPersonalizedAction')
}

export async function fetchSeriesAction() {
  return unexpectedCall('fetchSeriesAction')
}

export async function fetchAuthorsAction() {
  return unexpectedCall('fetchAuthorsAction')
}

export async function fetchCollectionsAction() {
  return unexpectedCall('fetchCollectionsAction')
}

export async function fetchPlaylistsAction() {
  return unexpectedCall('fetchPlaylistsAction')
}

export async function fetchRecentEpisodesAction() {
  return unexpectedCall('fetchRecentEpisodesAction')
}

export async function removeLibraryItemsWithIssuesAction() {
  return unexpectedCall('removeLibraryItemsWithIssuesAction')
}
