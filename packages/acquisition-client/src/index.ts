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
    status: () => request<AcquisitionStatusResponse>('/status')
  }
}
