import AcquisitionSettingsClient from '@/app/(main)/settings/acquisition/AcquisitionSettingsClient'
import { AcquisitionContext, type AcquisitionContextValue } from '@/contexts/AcquisitionContext'
import type { AcquisitionStatusResponse } from '@/lib/acquisition'

function status(overrides: Partial<AcquisitionStatusResponse> = {}): AcquisitionStatusResponse {
  return {
    version: '1.0.0',
    ready: true,
    librarr: { reachable: true },
    staging: { ready: true },
    libraries: [{ id: 'lib1', enabled: true }],
    ...overrides
  }
}

function mountWithStatus(value: AcquisitionStatusResponse | null) {
  const context: AcquisitionContextValue = {
    status: value,
    isLibraryEnabled: () => true,
    getQueue: () => undefined,
    ensureQueueLoaded: () => {},
    refreshQueue: () => Promise.resolve(),
    applyAcquisition: () => {}
  }

  cy.mount(
    <AcquisitionContext.Provider value={context}>
      <AcquisitionSettingsClient />
    </AcquisitionContext.Provider>
  )
}

describe('<AcquisitionSettingsClient />', () => {
  it('shows readiness without any credential controls', () => {
    mountWithStatus(status())
    cy.contains('Connected').should('exist')
    cy.get('[cy-id=acquisition-status-gateway]').should('contain.text', 'Connected')
    cy.get('[cy-id=acquisition-status-librarr]').should('contain.text', 'Connected')
    cy.get('[cy-id=acquisition-status-staging]').should('contain.text', 'Connected')
    cy.get('[cy-id=acquisition-enabled-libraries]').should('contain.text', 'lib1')
    cy.get('input[type=password]').should('not.exist')
    cy.contains(/api key/i).should('not.exist')
    cy.contains(/token/i).should('not.exist')
  })

  it('shows Offline for an unreachable dependency', () => {
    mountWithStatus(status({ ready: false, librarr: { reachable: false } }))
    cy.get('[cy-id=acquisition-status-gateway]').should('contain.text', 'Offline')
    cy.get('[cy-id=acquisition-status-librarr]').should('contain.text', 'Offline')
    cy.get('[cy-id=acquisition-status-staging]').should('contain.text', 'Connected')
  })

  it('shows a loading state before status has loaded', () => {
    mountWithStatus(null)
    cy.get('[cy-id=acquisition-status-rows]').should('not.exist')
  })
})
