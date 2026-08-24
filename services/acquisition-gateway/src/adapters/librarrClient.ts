import { z } from 'zod'
import {
  LibrarrSearchResponseSchema,
  LibrarrSubmitResponseSchema,
  LibrarrDownloadsResponseSchema,
  LibrarrHealthResponseSchema,
  type LibrarrSearchResult,
  type LibrarrSubmitResponse,
  type LibrarrDownloadStatus
} from './librarrSchemas'

export class LibrarrApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message)
    this.name = 'LibrarrApiError'
  }
}

export interface LibrarrClientOptions {
  baseUrl: string
  apiKey: string
  fetcher?: typeof fetch
}

/**
 * Classifies a non-2xx Librarr response into a stable, machine-readable code. In particular
 * detects Librarr's "SABnzbd not configured" 400 (internal/api/download.go:504-509) so callers
 * can surface it as a stable non-retryable error instead of a generic submit failure -- this
 * deployment runs Decypharr's qBittorrent facade only, never SABnzbd (WI-1496 correction #3).
 */
function classifyError(status: number, body: unknown): string {
  const message = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : ''
  if (status === 400 && message.toLowerCase().includes('sabnzbd not configured')) return 'sabnzbd_not_configured'
  if (status === 409) return 'already_in_library'
  return 'librarr_error'
}

const successSchema = z.object({ success: z.boolean() })

export class LibrarrClient {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly fetcher: typeof fetch

  constructor(options: LibrarrClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.apiKey = options.apiKey
    this.fetcher = options.fetcher ?? fetch
  }

  // Duck-typed instead of z.ZodType<T> -- with a `.default()` in the schema, zod's Input and
  // Output types diverge, and binding both to a single generic T via ZodType<T> makes
  // TypeScript infer T from the (optional-fields) Input side, not the parsed Output side.
  private async request<T>(path: string, schema: { parse: (data: unknown) => T }, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('x-api-key', this.apiKey)
    const response = await this.fetcher(`${this.baseUrl}${path}`, { ...init, headers })
    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      body = null
    }
    if (!response.ok) {
      const code = classifyError(response.status, body)
      const message =
        body && typeof body === 'object' && 'error' in body
          ? String((body as { error: unknown }).error)
          : `Librarr request failed with status ${response.status}`
      throw new LibrarrApiError(response.status, code, message)
    }
    return schema.parse(body)
  }

  async searchAudiobooks(query: string): Promise<LibrarrSearchResult[]> {
    const response = await this.request(
      `/api/search/audiobooks?${new URLSearchParams({ q: query })}`,
      LibrarrSearchResponseSchema
    )
    return response.results
  }

  /**
   * Submits the exact raw snapshot entry as Librarr's DownloadRequest body. SearchResult and
   * DownloadRequest share JSON field names for every field the gateway forwards (book.go:7-63
   * vs 188-204), so this is a byte-for-byte passthrough of the stored snapshot, never a
   * reconstructed object -- required so Librarr resolves the exact release the user picked.
   */
  async submitAudiobook(result: LibrarrSearchResult): Promise<LibrarrSubmitResponse> {
    return this.request('/api/download/audiobook', LibrarrSubmitResponseSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(result)
    })
  }

  async getDownloads(): Promise<LibrarrDownloadStatus[]> {
    const response = await this.request('/api/downloads', LibrarrDownloadsResponseSchema)
    return response.downloads
  }

  async deleteTorrent(hash: string): Promise<boolean> {
    const response = await this.request(`/api/downloads/torrent/${encodeURIComponent(hash)}`, successSchema, {
      method: 'DELETE'
    })
    return response.success
  }

  async deleteJob(jobId: string): Promise<boolean> {
    const response = await this.request(`/api/downloads/novel/${encodeURIComponent(jobId)}`, successSchema, {
      method: 'DELETE'
    })
    return response.success
  }

  async retryJob(jobId: string): Promise<boolean> {
    const response = await this.request(`/api/downloads/jobs/${encodeURIComponent(jobId)}/retry`, successSchema, {
      method: 'POST'
    })
    return response.success
  }

  /** GET /api/health (internal/api/health.go:29-63) -- real liveness+readiness probe. */
  async health(): Promise<boolean> {
    try {
      const response = await this.request('/api/health', LibrarrHealthResponseSchema)
      return response.status === 'ok'
    } catch {
      return false
    }
  }
}
