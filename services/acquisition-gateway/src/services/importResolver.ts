import path from 'node:path'
import type { AbsLibraryItem } from '../adapters/absAdminSchemas'
import { DomainError } from '../domain/errors'

export interface ImportEvidence {
  libraryId: string
  /** The gateway-owned final destination the handoff actually produced. */
  finalPath: string
  title: string
  author: string
  /** ISBN/ASIN when the release carried one; usually empty for torrent sources. */
  identifiers?: string[]
  /** Epoch ms. Items added at/after this time score the recency bonus. */
  scanStartedAt?: number
}

export interface ScoredItem {
  item: AbsLibraryItem
  score: number
}

/** A unique non-exact match must clear this to be accepted. Title(30) + author(20) + library
 * (100) + window(10) = 160 qualifies; title+author+window alone (60) never does, and
 * title-only (30, or 130 with the library bonus) is below it by construction. */
export const MIN_SCORE = 150

export function scoreItem(item: AbsLibraryItem, evidence: ImportEvidence): number {
  return (
    (samePath(item, evidence.finalPath) ? 1000 : 0) +
    (sameLibrary(item, evidence.libraryId) ? 100 : 0) +
    (sameIdentifier(item, evidence.identifiers) ? 80 : 0) +
    (sameTitle(item, evidence.title) ? 30 : 0) +
    (sameAuthor(item, evidence.author) ? 20 : 0) +
    (insideScanWindow(item, evidence.scanStartedAt) ? 10 : 0)
  )
}

/**
 * Picks the one ABS item this import produced, or refuses.
 *
 * Exact final-path equality wins outright -- it is the only evidence the gateway itself
 * created and therefore the only evidence that cannot be coincidence. Everything else must be
 * a UNIQUE match at or above MIN_SCORE. A tie at the top, a sub-threshold best, or a
 * title-only match all raise `ambiguous_import`, which the coordinator maps to
 * `needs_attention` (02-SETTLED-DECISIONS.md: "never guess").
 */
export function resolveImportedItem(evidence: ImportEvidence, items: AbsLibraryItem[]): AbsLibraryItem {
  // Hard filter, never a preference: each ABS library maps to exactly one final root
  // (02-SETTLED-DECISIONS.md), so an item in another library can never be this import no
  // matter how well its metadata scores.
  const pool = items.filter((item) => sameLibrary(item, evidence.libraryId))

  const exact = pool.filter((item) => samePath(item, evidence.finalPath))
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) {
    throw new DomainError('ambiguous_import', 'ambiguous_import: multiple ABS items share the final path', false)
  }

  const scored = pool
    .map((item) => ({ item, score: scoreItem(item, evidence) }))
    .filter((entry) => entry.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)

  if (scored.length === 0) {
    throw new DomainError('import_not_resolved', 'import_not_resolved: no ABS item matched the imported book', true)
  }
  if (scored.length > 1 && scored[0].score === scored[1].score) {
    throw new DomainError('ambiguous_import', 'ambiguous_import: two ABS items match the imported book equally well', false)
  }
  return scored[0].item
}

function normalizePath(value: string): string {
  // ABS runs on Linux and reports POSIX paths; the gateway may compute the destination on a
  // Windows dev host. Compare on separators and case-insensitively so a dev-host run and a
  // container run agree, and tolerate a trailing separator from either side.
  return path
    .normalize(value)
    .replace(/[\\/]+$/, '')
    .replace(/\\/g, '/')
    .toLowerCase()
}

export function samePath(item: AbsLibraryItem, finalPath: string): boolean {
  if (!item.path || !finalPath) return false
  return normalizePath(item.path) === normalizePath(finalPath)
}

function sameLibrary(item: AbsLibraryItem, libraryId: string): boolean {
  return Boolean(libraryId) && item.libraryId === libraryId
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function sameTitle(item: AbsLibraryItem, title: string): boolean {
  const expected = normalizeText(title)
  if (!expected) return false
  return normalizeText(item.media?.metadata?.title) === expected
}

function sameAuthor(item: AbsLibraryItem, author: string): boolean {
  const expected = normalizeText(author)
  if (!expected) return false
  return normalizeText(item.media?.metadata?.authorName) === expected
}

function sameIdentifier(item: AbsLibraryItem, identifiers: string[] | undefined): boolean {
  if (!identifiers?.length) return false
  const owned = new Set(
    [item.media?.metadata?.isbn, item.media?.metadata?.asin].filter((v): v is string => Boolean(v)).map((v) => v.toLowerCase())
  )
  return identifiers.some((id) => id && owned.has(id.toLowerCase()))
}

function insideScanWindow(item: AbsLibraryItem, scanStartedAt: number | undefined): boolean {
  if (scanStartedAt === undefined || item.addedAt === undefined) return false
  return item.addedAt >= scanStartedAt
}
