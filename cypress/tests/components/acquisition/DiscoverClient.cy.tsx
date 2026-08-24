import DiscoverClient, { type DiscoverApi } from '@/app/(main)/library/[library]/discover/DiscoverClient'
import GlobalToastContainer from '@/components/widgets/GlobalToastContainer'
import { AcquisitionContext, type AcquisitionContextValue } from '@/contexts/AcquisitionContext'
import { ToastProvider } from '@/contexts/ToastContext'
import type { Acquisition, SearchRelease, SearchResponse } from '@abs/acquisition-contract'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import type { AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import * as navigation from 'next/navigation'

function release(overrides: Partial<SearchRelease> = {}): SearchRelease {
  return {
    releaseId: 'release_12345678',
    title: 'Project Hail Mary',
    author: 'Andy Weir',
    narrators: ['Ray Porter'],
    format: 'm4b',
    sizeBytes: 742000000,
    durationSeconds: 61200,
    sourceLabel: 'AudioBookBay',
    qualityLabel: '64kbps',
    seeders: 12,
    coverUrl: null,
    alreadyOwned: false,
    existingAbsItemId: null,
    requestable: true,
    ...overrides
  }
}

function createMockAcquisitionContext(): AcquisitionContextValue {
  return {
    status: null,
    isLibraryEnabled: () => true,
    getQueue: () => undefined,
    ensureQueueLoaded: () => {},
    refreshQueue: () => Promise.resolve(),
    applyAcquisition: cy.stub().as('applyAcquisition')
  }
}

function mountDiscover(api: DiscoverApi, router: Partial<AppRouterInstance> = {}) {
  const routerInstance = {
    back: cy.stub(),
    forward: cy.stub(),
    refresh: cy.stub(),
    push: cy.stub().as('routerPush'),
    replace: cy.stub(),
    prefetch: cy.stub(),
    ...router
  } as AppRouterInstance

  cy.stub(navigation, 'useRouter').callsFake(() => routerInstance)

  cy.mount(
    <ToastProvider>
      <AppRouterContext.Provider value={routerInstance}>
        <AcquisitionContext.Provider value={createMockAcquisitionContext()}>
          <DiscoverClient libraryId="lib1" api={api} />
        </AcquisitionContext.Provider>
      </AppRouterContext.Provider>
      <GlobalToastContainer />
    </ToastProvider>
  )

  return routerInstance
}

describe('<DiscoverClient />', () => {
  it('submits the exact opaque release after confirmation', () => {
    const searchResponse: SearchResponse = { searchSessionId: 'search_12345678', results: [release()] }
    const created: Acquisition = {
      id: 'acq1',
      libraryId: 'lib1',
      title: 'Project Hail Mary',
      author: 'Andy Weir',
      state: 'queued',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }

    const api: DiscoverApi = {
      searchAudiobooks: cy.stub().as('search').resolves(searchResponse),
      createAcquisition: cy.stub().as('create').resolves(created)
    }

    mountDiscover(api)

    cy.get('[cy-id=text-input-field]').type('Project Hail Mary')
    cy.contains('button', 'Search').click()
    cy.get('@search').should('have.been.calledWith', 'lib1', 'Project Hail Mary')

    cy.contains('M4B').should('exist')
    cy.contains('button', 'Acquire').click()
    cy.contains('button', 'Confirm acquisition').click()

    cy.get('@create').should(
      'have.been.calledWith',
      'lib1',
      Cypress.sinon.match({ searchSessionId: 'search_12345678', releaseId: 'release_12345678' })
    )
    cy.get('@applyAcquisition').should('have.been.calledWith', 'lib1', created)
    cy.get('@routerPush').should('have.been.calledWith', '/library/lib1/acquisition-queue')
  })

  it('disables Acquire for a non-requestable or already-owned release', () => {
    const searchResponse: SearchResponse = {
      searchSessionId: 'search_12345678',
      results: [release({ releaseId: 'release_notreq01', requestable: false }), release({ releaseId: 'release_owned001', alreadyOwned: true })]
    }
    const api: DiscoverApi = {
      searchAudiobooks: cy.stub().as('search').resolves(searchResponse),
      createAcquisition: cy.stub().as('create')
    }

    mountDiscover(api)
    cy.get('[cy-id=text-input-field]').type('Project Hail Mary')
    cy.contains('button', 'Search').click()
    cy.get('[cy-id=release-card]').should('have.length', 2)
    cy.get('[cy-id=release-card]').each(($card) => {
      cy.wrap($card).contains('button', 'Acquire').should('be.disabled')
    })
  })

  it('shows a formatted error toast when search fails', () => {
    const api: DiscoverApi = {
      searchAudiobooks: cy.stub().as('search').rejects(new Error('boom')),
      createAcquisition: cy.stub().as('create')
    }

    mountDiscover(api)
    cy.get('[cy-id=text-input-field]').type('Project Hail Mary')
    cy.contains('button', 'Search').click()
    cy.contains('Something went wrong contacting the acquisition gateway').should('exist')
  })
})
