import ReleaseCard from '@/components/acquisition/ReleaseCard'
import type { SearchRelease } from '@abs/acquisition-contract'

// The wire format is the LEGACY one: `format` is the string 'unknown' when the source said
// nothing and `qualityLabel` is still sent for older clients. The card suppresses both.
function release(overrides: Partial<SearchRelease> = {}): SearchRelease {
  return {
    releaseId: 'release_12345678',
    title: 'The Children of Hurin - J.R.R. Tolkien',
    author: '',
    narrators: [],
    format: 'unknown',
    sizeBytes: null,
    sizeLabel: null,
    durationSeconds: null,
    sourceLabel: 'AudioBookBay',
    qualityLabel: 'Unknown',
    seeders: null,
    coverUrl: null,
    alreadyOwned: false,
    existingAbsItemId: null,
    requestable: true,
    ...overrides
  }
}

/** Asserts the exact, ordered text of every pill in the card's badge row. */
function expectPills(expected: string[]) {
  cy.get('[cy-id=release-card] .flex-wrap')
    .children()
    .should('have.length', expected.length)
    .then(($pills) => {
      expect(Array.from($pills).map((pill) => pill.textContent)).to.deep.equal(expected)
    })
}

describe('<ReleaseCard />', () => {
  ;['unknown', 'UNKNOWN', 'Unknown', ' unknown ', '', '   '].forEach((format) => {
    it(`renders no format pill for the absent-format value ${JSON.stringify(format)}`, () => {
      cy.mount(<ReleaseCard release={release({ format })} onAcquire={() => {}} />)
      expectPills(['AudioBookBay'])
    })
  })

  it('renders exactly one pill for a known format and never renders qualityLabel', () => {
    cy.mount(<ReleaseCard release={release({ format: 'm4b', qualityLabel: 'M4B' })} onAcquire={() => {}} />)
    expectPills(['M4B', 'AudioBookBay'])
  })

  it('renders no pill for a qualityLabel on a release with no format', () => {
    cy.mount(<ReleaseCard release={release({ format: 'unknown', qualityLabel: '320kbps' })} onAcquire={() => {}} />)
    expectPills(['AudioBookBay'])
  })

  it('prefers sizeBytes, falls back to sizeLabel, and shows no size pill for null or blank', () => {
    cy.mount(<ReleaseCard release={release({ sizeBytes: 742000000, sizeLabel: '1.2 GB' })} onAcquire={() => {}} />)
    cy.get('[cy-id=release-card]').should('not.contain.text', '1.2 GB')
    cy.mount(<ReleaseCard release={release({ sizeLabel: '1.2 GB' })} onAcquire={() => {}} />)
    expectPills(['1.2 GB', 'AudioBookBay'])
    cy.mount(<ReleaseCard release={release({ sizeLabel: '   ' })} onAcquire={() => {}} />)
    expectPills(['AudioBookBay'])
  })

  it('tolerates an OLD gateway response with no sizeLabel key at all', () => {
    const { sizeLabel: _omitted, ...oldGatewayRelease } = release({ format: 'm4b', qualityLabel: 'M4B' })
    cy.mount(<ReleaseCard release={oldGatewayRelease} onAcquire={() => {}} />)
    expectPills(['M4B', 'AudioBookBay'])
  })
})
