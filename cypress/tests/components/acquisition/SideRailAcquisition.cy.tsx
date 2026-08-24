import SideRailContent from '@/app/(main)/SideRailContent'
import { AcquisitionContext, type AcquisitionContextValue } from '@/contexts/AcquisitionContext'
import { UserContext, type UserContextType } from '@/contexts/UserContext'
import { Library, User } from '@/types/api'
import * as navigation from 'next/navigation'

function createMockUserContextValue(): UserContextType {
  return {
    user: { id: 'user-1', type: 'admin' } as unknown as User,
    userCanUpdate: true,
    userCanDelete: true,
    userCanDownload: true,
    userCanUpload: true,
    userIsAdminOrUp: true,
    token: 'test-token',
    serverSettings: {} as UserContextType['serverSettings'],
    userDefaultLibraryId: 'lib1',
    ereaderDevices: [],
    Source: 'test',
    getMediaItemProgress: () => undefined,
    getBookmarksForLibraryItem: () => [],
    mergeServerSettings: () => {}
  }
}

function createMockAcquisitionContextValue(enabledLibraries: string[]): AcquisitionContextValue {
  return {
    status: { version: '1.0.0', ready: true, libraries: enabledLibraries.map((id) => ({ id, enabled: true })) },
    isLibraryEnabled: (libraryId: string) => enabledLibraries.includes(libraryId),
    getQueue: () => undefined,
    ensureQueueLoaded: () => {},
    refreshQueue: () => Promise.resolve(),
    applyAcquisition: () => {}
  }
}

function mountSideRail(options: { mediaType: Library['mediaType']; enabledLibraries: string[]; libraryId: string }) {
  cy.stub(navigation, 'usePathname').callsFake(() => `/library/${options.libraryId}/items`)

  cy.mount(
    <UserContext.Provider value={createMockUserContextValue()}>
      <AcquisitionContext.Provider value={createMockAcquisitionContextValue(options.enabledLibraries)}>
        <SideRailContent libraryId={options.libraryId} mediaType={options.mediaType} serverVersion="1.0.0" installSource="test" showFooter={false} />
      </AcquisitionContext.Provider>
    </UserContext.Provider>
  )
}

describe('<SideRailContent /> acquisition navigation', () => {
  it('shows Discover only for an enabled book library', () => {
    mountSideRail({ mediaType: 'book', enabledLibraries: ['lib1'], libraryId: 'lib1' })
    cy.get('a[href="/library/lib1/discover"]').should('exist').and('contain.text', 'Discover')
  })

  it('hides Discover for a podcast library even when enabled', () => {
    mountSideRail({ mediaType: 'podcast', enabledLibraries: ['lib1'], libraryId: 'lib1' })
    cy.get('a[href="/library/lib1/discover"]').should('not.exist')
  })

  it('hides Discover for a book library the gateway has not enabled', () => {
    mountSideRail({ mediaType: 'book', enabledLibraries: [], libraryId: 'lib1' })
    cy.get('a[href="/library/lib1/discover"]').should('not.exist')
  })
})
