import type { Acquisition, CreateAcquisitionBody, SearchResponse } from '@abs/acquisition-contract'

export class AcquisitionApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message)
  }
}

export interface AcquisitionStatusResponse {
  version: string
  ready: boolean
  libraries: { id: string; enabled: boolean }[]
}

export interface AcquisitionClientOptions {
  baseUrl: string
  getAccessToken?: () => Promise<string | null>
  fetcher?: typeof fetch
}

export function createAcquisitionClient(options: AcquisitionClientOptions) {
  const fetcher = options.fetcher ?? fetch
  const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const headers = new Headers(init.headers)
    headers.set('accept', 'application/json')
    const token = await options.getAccessToken?.()
    if (token) headers.set('authorization', `Bearer ${token}`)
    const response = await fetcher(`${options.baseUrl}${path}`, { ...init, headers, credentials: 'include' })
    const body = await response.json()
    if (!response.ok) {
      throw new AcquisitionApiError(response.status, body.code ?? 'gateway_error', body.message ?? 'Gateway request failed')
    }
    return body as T
  }
  return {
    status: () => request<AcquisitionStatusResponse>('/status'),
    searchAudiobooks: (libraryId: string, q: string) =>
      request<SearchResponse>(`/search/audiobooks?${new URLSearchParams({ libraryId, q })}`),
    createAcquisition: (libraryId: string, body: CreateAcquisitionBody) =>
      request<Acquisition>(`/acquisitions?${new URLSearchParams({ libraryId })}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      }),
    listAcquisitions: (libraryId: string) => request<Acquisition[]>(`/acquisitions?${new URLSearchParams({ libraryId })}`),
    getAcquisition: (acquisitionId: string) => request<Acquisition>(`/acquisitions/${acquisitionId}`),
    retryAcquisition: (acquisitionId: string) => request<Acquisition>(`/acquisitions/${acquisitionId}/retry`, { method: 'POST' }),
    cancelAcquisition: (acquisitionId: string) => request<Acquisition>(`/acquisitions/${acquisitionId}`, { method: 'DELETE' })
  }
}
