import AcquisitionQueueClient, { type AcquisitionQueueApi } from '@/app/(main)/library/[library]/acquisition-queue/AcquisitionQueueClient'
import GlobalToastContainer from '@/components/widgets/GlobalToastContainer'
import { AcquisitionContext, type AcquisitionContextValue } from '@/contexts/AcquisitionContext'
import { ToastProvider } from '@/contexts/ToastContext'
import type { Acquisition } from '@abs/acquisition-contract'

function acquisition(overrides: Partial<Acquisition> = {}): Acquisition {
  return {
    id: 'acq1',
    libraryId: 'lib1',
    title: 'Project Hail Mary',
    author: 'Andy Weir',
    state: 'downloading',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  }
}

function createMockAcquisitionContext(initial: Acquisition[]): { context: AcquisitionContextValue; applyAcquisition: sinon.SinonStub } {
  const applyAcquisition = cy.stub().as('applyAcquisition')
  return {
    applyAcquisition,
    context: {
      status: null,
      isLibraryEnabled: () => true,
      getQueue: () => initial,
      ensureQueueLoaded: () => {},
      refreshQueue: () => Promise.resolve(),
      applyAcquisition
    }
  }
}

function mountQueue(initial: Acquisition[], api: Partial<AcquisitionQueueApi> = {}) {
  const { context } = createMockAcquisitionContext(initial)
  // Only alias a fallback stub when the caller didn't already provide (and alias) one -- calling
  // `.as('retry')` a second time here would silently repoint the '@retry' alias at this unused
  // fallback instead of the stub actually wired into the component.
  const fullApi: AcquisitionQueueApi = {
    retryAcquisition: api.retryAcquisition ?? cy.stub().as('retry'),
    cancelAcquisition: api.cancelAcquisition ?? cy.stub().as('cancel')
  }

  cy.mount(
    <ToastProvider>
      <AcquisitionContext.Provider value={context}>
        <AcquisitionQueueClient libraryId="lib1" api={fullApi} />
      </AcquisitionContext.Provider>
      <GlobalToastContainer />
    </ToastProvider>
  )
}

describe('<AcquisitionQueueClient />', () => {
  it('clamps progress and shows an indeterminate marker with no percent', () => {
    mountQueue([acquisition({ id: 'a1', state: 'downloading', progressPercent: 120 })])
    cy.contains('100%').should('exist')

    mountQueue([acquisition({ id: 'a2', state: 'processing', progressPercent: undefined })])
    cy.get('[cy-id=acquisition-progress-indeterminate]').should('exist')
  })

  it('shows Open Book only for an available acquisition with a resolved ABS item', () => {
    mountQueue([acquisition({ id: 'a1', state: 'available', absItemId: 'abs1' })])
    cy.contains('a', 'Open Book').should('have.attr', 'href', '/library/lib1/item/abs1')
  })

  it('does not show Open Book for a downloading acquisition', () => {
    mountQueue([acquisition({ id: 'a1', state: 'downloading' })])
    cy.contains('Open Book').should('not.exist')
  })

  it('retries a failed retryable acquisition', () => {
    const failed = acquisition({ id: 'a1', state: 'failed', error: { code: 'download_stalled', message: 'Stalled', retryable: true, lastSuccessfulStage: null } })
    mountQueue([failed], { retryAcquisition: cy.stub().as('retry').resolves(acquisition({ id: 'a1', state: 'queued' })) })

    cy.contains('button', 'Retry').click()
    cy.get('@retry').should('have.been.calledWith', 'a1')
    cy.get('@applyAcquisition').should('have.been.calledWith', 'lib1', Cypress.sinon.match({ id: 'a1', state: 'queued' }))
  })

  it('does not offer Retry for a non-retryable failure', () => {
    const failed = acquisition({ id: 'a1', state: 'failed', error: { code: 'library_forbidden', message: 'Forbidden', retryable: false, lastSuccessfulStage: null } })
    mountQueue([failed])
    cy.contains('button', 'Retry').should('not.exist')
  })

  it('cancels a queued acquisition after confirmation', () => {
    mountQueue([acquisition({ id: 'a1', state: 'queued' })], { cancelAcquisition: cy.stub().as('cancel').resolves(acquisition({ id: 'a1', state: 'cancelled' })) })

    cy.contains('button', 'Cancel').click()
    cy.contains('button', 'Yes').click()
    cy.get('@cancel').should('have.been.calledWith', 'a1')
    cy.get('@applyAcquisition').should('have.been.calledWith', 'lib1', Cypress.sinon.match({ id: 'a1', state: 'cancelled' }))
  })

  it('does not offer Cancel for a finished acquisition', () => {
    mountQueue([acquisition({ id: 'a1', state: 'available', absItemId: 'abs1' })])
    cy.contains('button', 'Cancel').should('not.exist')
  })

  it('shows an empty-queue message with no acquisitions', () => {
    mountQueue([])
    cy.contains('No acquisitions yet').should('exist')
  })
})
