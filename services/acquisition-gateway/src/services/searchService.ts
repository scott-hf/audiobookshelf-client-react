import type { SearchResponse } from '@abs/acquisition-contract'
import type { LibrarrClient } from '../adapters/librarrClient'
import type { LibrarrSearchResult } from '../adapters/librarrSchemas'
import { SearchRepository, type SearchSessionRecord } from '../db/searchRepository'
import { DomainError } from '../domain/errors'
import { opaqueId, toPublicRelease } from '../domain/releaseIdentity'

interface SnapshotEntry {
  releaseId: string
  raw: LibrarrSearchResult
}

export interface SearchServiceOptions {
  librarr: LibrarrClient
  repo: SearchRepository
  ttlSeconds: number
  now?: () => number
}

export interface ResolvedRelease {
  session: SearchSessionRecord
  raw: LibrarrSearchResult
}

export class SearchService {
  private readonly librarr: LibrarrClient
  private readonly repo: SearchRepository
  private readonly ttlSeconds: number
  private readonly now: () => number

  constructor(options: SearchServiceOptions) {
    this.librarr = options.librarr
    this.repo = options.repo
    this.ttlSeconds = options.ttlSeconds
    this.now = options.now ?? Date.now
  }

  async search(userId: string, libraryId: string, query: string): Promise<SearchResponse> {
    const raw = await this.librarr.searchAudiobooks(query)
    const entries: SnapshotEntry[] = raw.map((r) => ({ releaseId: opaqueId('release'), raw: r }))
    const sessionId = opaqueId('search')
    const nowIso = new Date(this.now()).toISOString()
    const expiresAt = new Date(this.now() + this.ttlSeconds * 1000).toISOString()

    this.repo.create({
      id: sessionId,
      absUserId: userId,
      absLibraryId: libraryId,
      query,
      resultsJson: JSON.stringify(entries),
      expiresAt,
      createdAt: nowIso
    })

    return {
      searchSessionId: sessionId,
      results: entries.map((e) => toPublicRelease(e.raw, e.releaseId))
    }
  }

  /** Resolves a session+release pair back to its exact raw Librarr snapshot entry, enforcing
   * ownership and expiry. Never falls back to re-searching or title matching. */
  resolveRelease(userId: string, searchSessionId: string, releaseId: string): ResolvedRelease {
    const session = this.repo.findById(searchSessionId)
    if (!session || session.absUserId !== userId) {
      throw new DomainError('search_not_found', 'search_not_found: search session not found', false)
    }
    if (new Date(session.expiresAt).getTime() <= this.now()) {
      throw new DomainError('search_expired', 'search_expired: search session has expired', false)
    }
    const entries = JSON.parse(session.resultsJson) as SnapshotEntry[]
    const entry = entries.find((e) => e.releaseId === releaseId)
    if (!entry) {
      throw new DomainError('release_not_found', 'release_not_found: release not found in search session', false)
    }
    return { session, raw: entry.raw }
  }
}

export { SearchRepository }
