import { describe, expect, it } from 'vitest'
import type { AbsLibraryItem } from '../adapters/absAdminSchemas'
import { MIN_SCORE, resolveImportedItem, scoreItem, type ImportEvidence } from './importResolver'

const evidence: ImportEvidence = {
  libraryId: 'lib-test',
  finalPath: '/library/Andy Weir/Project Hail Mary',
  title: 'Project Hail Mary',
  author: 'Andy Weir',
  identifiers: ['B08G9PRS1K'],
  scanStartedAt: 1_700_000_000_000
}

function item(overrides: {
  id: string
  path?: string
  libraryId?: string
  title?: string
  author?: string
  asin?: string
  isbn?: string
  addedAt?: number
}): AbsLibraryItem {
  return {
    id: overrides.id,
    libraryId: overrides.libraryId ?? evidence.libraryId,
    path: overrides.path ?? `/library/other/${overrides.id}`,
    addedAt: overrides.addedAt,
    media: { metadata: { title: overrides.title ?? null, authorName: overrides.author ?? null, asin: overrides.asin ?? null, isbn: overrides.isbn ?? null } }
  } as AbsLibraryItem
}

describe('resolveImportedItem', () => {
  it('prefers exact path and refuses equal plausible matches', () => {
    expect(
      resolveImportedItem(evidence, [item({ id: 'exact', path: evidence.finalPath }), item({ id: 'title', title: evidence.title })]).id
    ).toBe('exact')

    expect(() =>
      resolveImportedItem(evidence, [
        item({ id: 'a', title: evidence.title, author: evidence.author }),
        item({ id: 'b', title: evidence.title, author: evidence.author })
      ])
    ).toThrow('ambiguous_import')
  })

  it('matches an exact path across separator and trailing-slash differences', () => {
    expect(resolveImportedItem(evidence, [item({ id: 'exact', path: evidence.finalPath + '/' })]).id).toBe('exact')
  })

  it('accepts a strong identifier match without a path match', () => {
    const resolved = resolveImportedItem(evidence, [item({ id: 'asin', asin: 'b08g9prs1k' }), item({ id: 'noise' })])
    expect(resolved.id).toBe('asin')
  })

  it('accepts a unique title + author + scan-window match', () => {
    const resolved = resolveImportedItem(evidence, [
      item({ id: 'good', title: 'Project Hail Mary', author: 'Andy Weir', addedAt: evidence.scanStartedAt! + 5_000 }),
      item({ id: 'old', title: 'Artemis', author: 'Andy Weir', addedAt: 1 })
    ])
    expect(resolved.id).toBe('good')
  })

  it('never resolves on title alone', () => {
    expect(scoreItem(item({ id: 't', title: evidence.title }), evidence)).toBeLessThan(MIN_SCORE)
    expect(() => resolveImportedItem(evidence, [item({ id: 't', title: evidence.title })])).toThrow('import_not_resolved')
  })

  it('never resolves on author alone', () => {
    expect(() => resolveImportedItem(evidence, [item({ id: 'a', author: evidence.author })])).toThrow('import_not_resolved')
  })

  it('reports no match as retryable and an ambiguous match as non-retryable', () => {
    const notResolved = catchError(() => resolveImportedItem(evidence, [item({ id: 'x' })]))
    expect(notResolved).toMatchObject({ code: 'import_not_resolved', retryable: true })

    const ambiguous = catchError(() =>
      resolveImportedItem(evidence, [
        item({ id: 'a', title: evidence.title, author: evidence.author }),
        item({ id: 'b', title: evidence.title, author: evidence.author })
      ])
    )
    expect(ambiguous).toMatchObject({ code: 'ambiguous_import', retryable: false })
  })

  it('ignores items in a different library', () => {
    expect(() =>
      resolveImportedItem(evidence, [item({ id: 'wrong', libraryId: 'lib-other', path: evidence.finalPath })])
    ).toThrow('import_not_resolved')
  })

  it('refuses two ABS items sharing the final path', () => {
    expect(() =>
      resolveImportedItem(evidence, [item({ id: 'a', path: evidence.finalPath }), item({ id: 'b', path: evidence.finalPath })])
    ).toThrow('ambiguous_import')
  })

  it('normalizes punctuation and case when comparing metadata', () => {
    const resolved = resolveImportedItem({ ...evidence, identifiers: [] }, [
      item({ id: 'p', title: 'project hail  mary!', author: 'ANDY WEIR', addedAt: evidence.scanStartedAt! + 1 })
    ])
    expect(resolved.id).toBe('p')
  })
})

function catchError(fn: () => unknown): unknown {
  try {
    fn()
    return null
  } catch (error) {
    return error
  }
}
