/// <reference types="cypress" />
// Support file for the real (non-component) E2E project (cypress/e2e/**). Mirrors the
// cy-id shorthand from cypress/support/commands.ts (the component project's support file) --
// duplicated rather than shared because component and e2e are separate Cypress testingTypes
// with independent support-file resolution.
import 'cypress-real-events'

Cypress.Commands.overwriteQuery('get', function (originalFn, selector, options) {
  if (typeof selector === 'string' && selector.startsWith('&')) {
    selector = `[cy-id="${selector.substring(1)}"]`
  }
  return originalFn.apply(this, [selector, options])
})

/** Logs in through the app's real login route handler (src/app/internal-api/login/route.ts)
 * via a plain HTTP request rather than driving the login form -- this is a legitimate
 * "log in via API" helper (same intent as a typical loginByApi command), not a bypass: it
 * exercises the real Next route handler, the real fetch to the (fake, disposable) ABS
 * backend, and the real cookie-setting logic. Cypress shares its cookie jar with the browser
 * for same-origin requests, so subsequent cy.visit() calls are authenticated. */
Cypress.Commands.add('loginByApi', () => {
  cy.request('POST', '/internal-api/login', { username: 'e2e-admin', password: 'e2e-password' })
})

/* eslint-disable @typescript-eslint/no-namespace -- Cypress's own documented pattern for
   augmenting Chainable requires a `declare global { namespace Cypress { ... } }` block. */
declare global {
  namespace Cypress {
    interface Chainable {
      loginByApi(): Chainable<Cypress.Response<unknown>>
    }
  }
}
/* eslint-enable @typescript-eslint/no-namespace */
