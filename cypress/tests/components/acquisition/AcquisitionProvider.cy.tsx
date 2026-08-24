import { AcquisitionProvider, useAcquisition } from '@/contexts/AcquisitionContext'

function Probe({ libraryId }: { libraryId: string }) {
  const { status, isLibraryEnabled, getQueue, ensureQueueLoaded } = useAcquisition()

  ensureQueueLoaded(libraryId)

  return (
    <div>
      <div cy-id="acquisition-status-ready">{status ? String(status.ready) : 'loading'}</div>
      <div cy-id="acquisition-enabled">{String(isLibraryEnabled(libraryId))}</div>
      <div cy-id="acquisition-queue-length">{String(getQueue(libraryId)?.length ?? 0)}</div>
    </div>
  )
}

describe('<AcquisitionProvider />', () => {
  it('loads status and exposes library enablement', () => {
    cy.intercept('GET', '/acquisition-api/v1/status', { version: '1.0.0', ready: true, libraries: [{ id: 'lib1', enabled: true }] }).as('status')
    cy.intercept('GET', '/acquisition-api/v1/acquisitions*', { statusCode: 200, body: [] }).as('queue')
    cy.intercept('GET', '/acquisition-api/v1/events', { statusCode: 200, headers: { 'content-type': 'text/event-stream' }, body: '' }).as('events')

    cy.mount(
      <AcquisitionProvider>
        <Probe libraryId="lib1" />
      </AcquisitionProvider>
    )

    cy.wait('@status')
    cy.get('[cy-id=acquisition-status-ready]').should('contain.text', 'true')
    cy.get('[cy-id=acquisition-enabled]').should('contain.text', 'true')
    cy.wait('@queue')
    cy.get('[cy-id=acquisition-queue-length]').should('contain.text', '0')
  })

  it('falls back to polling after an SSE error', () => {
    cy.clock()
    cy.intercept('GET', '/acquisition-api/v1/status', { version: '1.0.0', ready: true, libraries: [{ id: 'lib1', enabled: true }] }).as('status')
    cy.intercept('GET', '/acquisition-api/v1/acquisitions*', { statusCode: 200, body: [] }).as('queue')
    cy.intercept('GET', '/acquisition-api/v1/events', { statusCode: 200, headers: { 'content-type': 'text/event-stream' }, body: '' }).as('events')

    cy.mount(
      <AcquisitionProvider>
        <Probe libraryId="lib1" />
      </AcquisitionProvider>
    )

    cy.wait('@status')
    cy.wait('@queue')

    cy.window().then((win) => win.dispatchEvent(new CustomEvent('test-acquisition-sse-error')))
    cy.tick(10_000)
    cy.wait('@queue')
    cy.get('@queue.all').should('have.length', 2)
  })
})
