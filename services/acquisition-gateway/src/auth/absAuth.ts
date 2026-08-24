import { createHash } from 'node:crypto'

export interface AbsUser {
  id: string
  librariesAccessible?: string[]
  isActive?: boolean
  permissions?: { accessAllLibraries?: boolean }
}

export type AbsValidator = (token: string) => Promise<AbsUser>

export interface GatewayAuthError extends Error {
  statusCode: number
}

function unauthorized(): GatewayAuthError {
  return Object.assign(new Error('Unauthorized'), { statusCode: 401 })
}

export function extractAccessToken(headers: { authorization?: string; cookie?: string }): string | null {
  const bearer = headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (bearer) return bearer
  return parseCookie(headers.cookie ?? '').access_token ?? null
}

function parseCookie(header: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of header.split(';')) {
    const [rawKey, ...rest] = part.trim().split('=')
    if (!rawKey) continue
    out[rawKey] = decodeURIComponent(rest.join('='))
  }
  return out
}

/** Real ABS validation: GET /api/me (audiobookshelf server/routers/ApiRouter.js:173). */
export async function validateAbsUser(token: string, absUrl: string, fetcher: typeof fetch): Promise<AbsUser> {
  const response = await fetcher(`${absUrl}/api/me`, { headers: { authorization: `Bearer ${token}` } })
  if (!response.ok) throw unauthorized()
  const user = (await response.json()) as AbsUser
  if (!user?.id || user.isActive === false) throw unauthorized()
  return user
}

interface CacheEntry {
  user: AbsUser
  expiresAt: number
}

const CACHE_TTL_MS = 30_000

export interface CreateAbsAuthOptions {
  validate: AbsValidator
  /** Injectable clock for deterministic cache-expiry tests. Defaults to Date.now. */
  now?: () => number
}

/**
 * Builds the request-level auth check: bearer wins over cookie, fails closed on any
 * validator error/invalid user, and caches only successful validations by a SHA-256
 * token fingerprint for 30 seconds (02-SETTLED-DECISIONS.md). The raw token itself is
 * never stored or logged -- only its fingerprint is used as the cache key.
 */
export function createAbsAuth(options: CreateAbsAuthOptions) {
  const cache = new Map<string, CacheEntry>()
  const now = options.now ?? (() => Date.now())

  return async function auth(request: { headers: { authorization?: string; cookie?: string } }): Promise<AbsUser> {
    const token = extractAccessToken(request.headers)
    if (!token) throw unauthorized()

    const fingerprint = createHash('sha256').update(token).digest('hex')
    const cached = cache.get(fingerprint)
    if (cached && cached.expiresAt > now()) {
      return cached.user
    }

    let user: AbsUser
    try {
      user = await options.validate(token)
    } catch {
      throw unauthorized()
    }
    if (!user?.id || user.isActive === false) throw unauthorized()

    cache.set(fingerprint, { user, expiresAt: now() + CACHE_TTL_MS })
    return user
  }
}
