/**
 * Full browser acquisition journey (WI-1496 Gate 4 acceptance): search -> confirm the exact
 * release -> acquire -> see it in the queue -> see it become available -> Open Book.
 *
 * Runs against a REAL `next dev` server and a REAL browser click-through (this is the `e2e`
 * Cypress project, not `component`). Two things are still faked, both disposable and
 * documented in cypress/e2e/support/fakeAbsServer.mjs / docs/implementation-status.md:
 *   - The Audiobookshelf backend the Next server talks to server-side for login/session
 *     (no real ABS instance, droplet, or credentials exist in this environment).
 *   - The acquisition-gateway HTTP surface the browser talks to for /acquisition-api/v1/*
 *     (intercepted directly -- the gateway's own business logic, reconciler, and Librarr/ABS
 *     integration already have dedicated real-integration coverage in
 *     services/acquisition-gateway/test/e2e/importJourney.test.ts, Gates 1-3; this spec's job
 *     is the React UI's behavior, not re-proving the backend).
 */

const LIBRARY_ID = 'lib1'

function interceptStatus() {
  cy.intercept('GET', '/acquisition-api/v1/status', {
    version: '1.0.0',
    ready: true,
    librarr: { reachable: true },
    staging: { ready: true },
    libraries: [{ id: LIBRARY_ID, enabled: true }]
  }).as('status')
}

function interceptSearch() {
  cy.intercept('GET', `/acquisition-api/v1/search/audiobooks?*`, { fixture: 'acquisition/search.json' }).as('search')
}

function interceptCreate() {
  cy.intercept('POST', `/acquisition-api/v1/acquisitions?*`, (req) => {
    req.reply({
      statusCode: 201,
      body: {
        id: 'acq_e2e_00000001',
        libraryId: LIBRARY_ID,
        title: 'Project Hail Mary',
        author: 'Andy Weir',
        state: 'queued',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    })
  }).as('create')
}

/** First poll of the queue shows it mid-download; every poll after that shows it available --
 * exercises the real "queue -> available" transition the acceptance criterion names, without
 * depending on a real EventSource push (the browser's real EventSource to the non-existent
 * gateway errors immediately, which AcquisitionProvider already treats as "fall back to
 * polling" -- exactly the path AcquisitionProvider.cy.tsx covers at the component level). */
function interceptQueueTransition() {
  let calls = 0
  cy.intercept('GET', `/acquisition-api/v1/acquisitions?*`, (req) => {
    calls += 1
    if (calls === 1) {
      req.reply([
        {
          id: 'acq_e2e_00000001',
          libraryId: LIBRARY_ID,
          title: 'Project Hail Mary',
          author: 'Andy Weir',
          state: 'downloading',
          progressPercent: 42,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ])
    } else {
      req.reply({ fixture: 'acquisition/queue-available.json' })
    }
  }).as('queue')
}

function runJourney() {
  cy.loginByApi()
  interceptStatus()
  interceptSearch()
  interceptCreate()
  interceptQueueTransition()

  cy.visit(`/library/${LIBRARY_ID}/discover`)
  cy.wait('@status')

  cy.get('&text-input-field').type('Project Hail Mary')
  cy.contains('button', 'Search').click()
  cy.wait('@search')

  cy.get('[cy-id=discover-results]').should('exist')
  cy.contains('Project Hail Mary').should('exist')
  cy.contains('M4B').should('exist')

  cy.contains('button', 'Acquire').click()
  cy.contains('button', 'Confirm acquisition').click()
  cy.wait('@create')

  // Acquiring navigates to the queue automatically (DiscoverClient.handleConfirmAcquisition).
  cy.location('pathname').should('eq', `/library/${LIBRARY_ID}/acquisition-queue`)
  cy.wait('@queue')
  cy.contains('Downloading').should('exist')
  cy.contains('a', 'Open Book').should('not.exist')

  // POLL_INTERVAL_MS in AcquisitionContext.tsx is a fixed 10s; wait past it for the real
  // polling fallback to pick up the second (available) queue response.
  cy.wait('@queue', { timeout: 15000 })
  cy.contains('Available').should('exist')
  cy.contains('a', 'Open Book').should('have.attr', 'href', `/library/${LIBRARY_ID}/item/abs_e2e_item_1`).click()
  cy.location('pathname').should('eq', `/library/${LIBRARY_ID}/item/abs_e2e_item_1`)
}

describe('acquisition web journey', () => {
  it('completes search -> confirm -> acquire -> queue -> available -> Open Book (desktop)', () => {
    cy.viewport(1280, 800)
    runJourney()
  })

  it('completes search -> confirm -> acquire -> queue -> available -> Open Book (mobile)', () => {
    cy.viewport('iphone-x')
    runJourney()
  })
})
