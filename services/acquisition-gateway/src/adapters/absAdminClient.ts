import { AbsLibraryItemsResponseSchema, type AbsLibraryItem } from './absAdminSchemas'

export class AbsApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message)
    this.name = 'AbsApiError'
  }
}

export interface AbsAdminClientOptions {
  baseUrl: string
  /** The gateway's ABS service token. Never accepted from a client and never echoed back. */
  serviceToken: string
  fetcher?: typeof fetch
  timeoutMs?: number
}

const PAGE_SIZE = 100
/** Hard stop so a paging bug or a hostile `total` cannot spin the reconciler forever. */
const MAX_PAGES = 200

/**
 * The gateway's privileged ABS client: trigger a library scan and read that library's items
 * back so the import can be resolved to exactly one item ID. Deliberately narrow -- ABS
 * remains the authority for users, catalog, playback and progress, and this adapter never
 * writes catalog data (02-SETTLED-DECISIONS.md, "Service boundaries").
 */
export class AbsAdminClient {
  private readonly baseUrl: string
  private readonly serviceToken: string
  private readonly fetcher: typeof fetch
  private readonly timeoutMs: number

  constructor(options: AbsAdminClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.serviceToken = options.serviceToken
    this.fetcher = options.fetcher ?? fetch
    this.timeoutMs = options.timeoutMs ?? 30_000
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { ...(init.headers ?? {}), authorization: `Bearer ${this.serviceToken}`, accept: 'application/json' }
      })
    } catch (error) {
      // The token can appear in a fetch/undici cause chain; never let it reach a log or an
      // API error body. Only the sanitized reason survives.
      const reason = (error as Error)?.name === 'AbortError' ? 'request timed out' : 'request failed'
      throw new AbsApiError(0, 'abs_unreachable', `Audiobookshelf ${reason}`)
    } finally {
      clearTimeout(timer)
    }

    if (!response.ok) {
      throw new AbsApiError(response.status, classify(response.status), `Audiobookshelf request failed with status ${response.status}`)
    }
    if (response.status === 204) return undefined
    try {
      return await response.json()
    } catch {
      return undefined
    }
  }

  /** POST /api/libraries/:id/scan (ApiRouter.js:91). Returns once ABS accepts the request. */
  async scanLibrary(libraryId: string): Promise<void> {
    await this.request(`/api/libraries/${encodeURIComponent(libraryId)}/scan`, { method: 'POST' })
  }

  /** One page of GET /api/libraries/:id/items, minified. */
  async listLibraryItems(libraryId: string, options: { limit?: number; page?: number } = {}): Promise<AbsLibraryItem[]> {
    const query = new URLSearchParams({
      limit: String(options.limit ?? PAGE_SIZE),
      page: String(options.page ?? 0),
      minified: '1'
    })
    const body = await this.request(`/api/libraries/${encodeURIComponent(libraryId)}/items?${query}`)
    return AbsLibraryItemsResponseSchema.parse(body).results
  }

  /** Every item in the library, paged. Only this library is ever queried. */
  async listAllLibraryItems(libraryId: string): Promise<AbsLibraryItem[]> {
    const all: AbsLibraryItem[] = []
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const results = await this.listLibraryItems(libraryId, { limit: PAGE_SIZE, page })
      all.push(...results)
      if (results.length < PAGE_SIZE) break
    }
    return all
  }
}

function classify(status: number): string {
  if (status === 401 || status === 403) return 'abs_unauthorized'
  if (status === 404) return 'abs_not_found'
  return 'abs_error'
}
