import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ZodError } from 'zod'
import {
  DISCOVER_MAX_OFFSET,
  DISCOVER_PAGE_SIZE,
  DiscoverBrowseQuerySchema,
  type DiscoverBrowseResponse,
  type DiscoverOptionsResponse
} from '@abs/acquisition-contract'
import { LibrarrApiError, LibrarrTimeoutError, type LibrarrClient } from '../adapters/librarrClient'

function gatewayError(code: string, message: string, retryable: boolean) {
  return { code, message, retryable, lastSuccessfulStage: null }
}

/**
 * Maps a failure from the Librarr adapter to the HTTP answer a client can act on. Librarr's own
 * outage statuses are handled separately (they arrive as HTTP 200); this covers everything that
 * went wrong around the call.
 */
function sendLibrarrFailure(request: FastifyRequest, reply: FastifyReply, error: unknown, callerSignal?: AbortSignal): FastifyReply {
  if (callerSignal?.aborted) {
    // The caller's connection is gone, so nobody reads this: no error log, no 5xx, just unwind.
    return reply.code(499).send()
  }
  if (error instanceof LibrarrTimeoutError) {
    // Same code and retryability the acquisition path already records for a Librarr timeout.
    return reply.code(504).send(gatewayError('librarr_timeout', 'Librarr did not respond in time', true))
  }
  if (error instanceof LibrarrApiError) {
    // An older Librarr that predates the discover routes (or a base URL that is not Librarr).
    if (error.status === 404) {
      return reply.code(404).send(gatewayError('discover_not_supported', 'This Librarr does not support book suggestions', false))
    }
    // A transport-level 429 is still a rate limit, not a permanent failure. LibrarrApiError does
    // not carry the response headers, so no Retry-After can be forwarded on this path.
    if (error.status === 429) {
      request.log.warn({ status: error.status, code: error.code }, 'librarr discover request was rate limited')
      return reply.code(429).send(gatewayError('discover_rate_limited', 'Open Library is rate limiting requests', true))
    }
    request.log.warn({ status: error.status, code: error.code }, 'librarr discover request failed')
    return reply.code(502).send(gatewayError('librarr_error', 'Librarr could not serve the request', error.status >= 500))
  }
  if (error instanceof ZodError) {
    request.log.warn({ issues: error.issues }, 'librarr discover response did not match the expected shape')
    return reply.code(502).send(gatewayError('discover_bad_response', 'Librarr returned an unexpected response', false))
  }
  if (error instanceof TypeError) {
    // fetch rejects with TypeError for every pre-response failure (refused, DNS, reset).
    request.log.warn({ err: error }, 'librarr discover request could not reach Librarr')
    return reply.code(502).send(gatewayError('librarr_unreachable', 'Librarr could not be reached', true))
  }
  throw error
}

/** A cursor a client may safely follow: a page boundary, in range, and strictly ahead of the
 * page it came from. Anything else is dropped to `null` by the caller so a bad upstream can
 * never loop the client. */
function isAdvancingCursor(next: number, requestOffset: number): boolean {
  return Number.isInteger(next) && next % DISCOVER_PAGE_SIZE === 0 && next <= DISCOVER_MAX_OFFSET && next > requestOffset
}

export function registerDiscoverRoutes(app: FastifyInstance, librarr: LibrarrClient): void {
  app.register(
    async (instance) => {
      instance.get('/discover/options', async (request, reply) => {
        try {
          const options = await librarr.getDiscoverOptions()
          const body: DiscoverOptionsResponse = { catalogs: options.catalogs, genres: options.genres }
          return reply.header('cache-control', 'no-store').code(200).send(body)
        } catch (error) {
          return sendLibrarrFailure(request, reply, error)
        }
      })

      instance.get('/discover/browse', async (request, reply) => {
        const parsed = DiscoverBrowseQuerySchema.safeParse(request.query)
        if (!parsed.success) {
          return reply
            .code(400)
            .send(gatewayError('invalid_query', 'catalog is required, and offset must be a multiple of 20 from 0 to 180', false))
        }
        const { catalog, offset } = parsed.data
        // A blank genre means "no genre", the same as omitting it.
        const genre = parsed.data.genre ? parsed.data.genre : undefined

        // Aborts when the caller's connection closes before the answer is sent, so an abandoned
        // request stops consuming Librarr's shared discover rate-limit bucket.
        const callerGone = new AbortController()
        reply.raw.once('close', () => {
          if (!reply.raw.writableEnded) callerGone.abort()
        })

        let browse
        try {
          browse = await librarr.browseDiscover(catalog, genre, offset, callerGone.signal)
        } catch (error) {
          return sendLibrarrFailure(request, reply, error, callerGone.signal)
        }

        // Librarr reports these over HTTP 200; clients must not have to read a field to tell an
        // outage from an empty shelf, so they become real HTTP errors here.
        if (browse.status === 'upstream_unavailable') {
          request.log.warn({ catalog, genre, offset, error: browse.error }, 'librarr reports Open Library unavailable')
          return reply
            .code(502)
            .send(gatewayError('discover_upstream_unavailable', 'Open Library is unavailable', true))
        }
        if (browse.status === 'rate_limited') {
          request.log.warn({ catalog, genre, offset, error: browse.error }, 'librarr reports Open Library rate limited')
          if (browse.retryAfter) reply.header('retry-after', browse.retryAfter)
          return reply.code(429).send(gatewayError('discover_rate_limited', 'Open Library is rate limiting requests', true))
        }

        // The response echoes the REQUEST. Librarr's echo is absent on failures, so it is only a
        // consistency check here: a mismatch means Librarr answered a different question, and its
        // items and cursor must not be served under the request's labels (a reply for offset 20
        // shown as page zero would make the client skip the real first page).
        if (
          (browse.catalog !== undefined && browse.catalog !== catalog) ||
          (browse.genre !== undefined && browse.genre !== (genre ?? '')) ||
          (browse.offset !== undefined && browse.offset !== offset)
        ) {
          request.log.warn(
            {
              requested: { catalog, genre: genre ?? '', offset },
              echoed: { catalog: browse.catalog, genre: browse.genre, offset: browse.offset }
            },
            'librarr discover echo does not match the request'
          )
          return reply.code(502).send(gatewayError('discover_bad_response', 'Librarr returned an unexpected response', false))
        }

        let nextOffset: number | null = null
        if (browse.status !== 'invalid_request' && browse.nextOffset !== null) {
          if (isAdvancingCursor(browse.nextOffset, offset)) {
            nextOffset = browse.nextOffset
          } else {
            request.log.warn(
              { requestOffset: offset, nextOffset: browse.nextOffset },
              'librarr discover next_offset is not a forward page boundary; treating as last page'
            )
          }
        }

        const body: DiscoverBrowseResponse = {
          status: browse.status,
          catalog,
          genre: genre ?? '',
          offset,
          nextOffset,
          partial: browse.status === 'invalid_request' ? false : browse.partial,
          items: browse.status === 'invalid_request' ? [] : browse.items
        }
        return reply.header('cache-control', 'no-store').code(200).send(body)
      })
    },
    { prefix: '/acquisition-api/v1' }
  )
}
