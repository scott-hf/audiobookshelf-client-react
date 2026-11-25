import { z } from 'zod'

export const AcquisitionStateSchema = z.enum([
  'queued',
  'submitted',
  'downloading',
  'processing',
  'staged',
  'importing',
  'scanning',
  'available',
  'failed',
  'cancelled',
  'needs_attention'
])

export const GatewayErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  lastSuccessfulStage: z.string().nullable()
})

export const AcquisitionSchema = z.object({
  id: z.string(),
  libraryId: z.string(),
  title: z.string(),
  author: z.string(),
  state: AcquisitionStateSchema,
  progressPercent: z.number().min(0).max(100).nullable().optional(),
  absItemId: z.string().nullable().optional(),
  error: GatewayErrorSchema.nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
})

export const CreateAcquisitionBodySchema = z.object({
  searchSessionId: z.string().min(12),
  releaseId: z.string().min(12),
  idempotencyKey: z.string().uuid()
})

export const SearchReleaseSchema = z.object({
  releaseId: z.string(),
  title: z.string(),
  author: z.string(),
  narrators: z.array(z.string()),
  format: z.string(),
  sizeBytes: z.number().nullable(),
  durationSeconds: z.number().nullable(),
  sourceLabel: z.string(),
  qualityLabel: z.string(),
  seeders: z.number().nullable(),
  coverUrl: z.string().nullable(),
  alreadyOwned: z.boolean(),
  existingAbsItemId: z.string().nullable(),
  // A torrent result is requestable if the gateway can identify it (info_hash, BTIH, or
  // abb_url for AudioBookBay); NZB results are never requestable in this deployment
  // (no SABnzbd). See services/acquisition-gateway/src/domain/releaseIdentity.ts.
  requestable: z.boolean()
})

export const SearchResponseSchema = z.object({
  searchSessionId: z.string(),
  results: z.array(SearchReleaseSchema)
})

export const SearchQuerySchema = z.object({
  libraryId: z.string().min(1),
  // Free text typed by a person. `.trim()` runs BEFORE `.min(1)` (zod runs string checks in
  // order), so a whitespace-only `q` is rejected as empty rather than accepted as non-empty, and
  // the value every consumer sees -- Librarr, the stored search session -- is already trimmed.
  q: z.string().trim().min(1)
})

/** Books per browse page, fixed by Librarr (`internal/discover/browse.go`). */
export const DISCOVER_PAGE_SIZE = 20
/** Librarr refuses an offset past this, so there are at most 10 pages per selection. */
export const DISCOVER_MAX_OFFSET = 180

export const DiscoverOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1)
})

export const DiscoverOptionsResponseSchema = z.object({
  catalogs: z.array(DiscoverOptionSchema),
  genres: z.array(DiscoverOptionSchema)
})

export const DiscoverItemSchema = z.object({
  /** Open Library work key, e.g. `/works/OL17930368W`. Stable, so it is the React key and the
   * primary dedupe identity -- two different keys are two different works even if the title and
   * author match. */
  key: z.string().min(1),
  title: z.string(),
  /** A single pre-joined string, not a list: measured on a live response, `"James Clear"`. */
  author: z.string(),
  /** Librarr sends `''` when Open Library has no cover; the gateway normalises that to null. */
  coverUrl: z.string().nullable(),
  /** Librarr sends 0 for "unknown"; the gateway normalises that to null. */
  year: z.number().int().nullable(),
  /** Open Library's reading-log count (measured: 66698 for Atomic Habits). Carried so a caller
   * *could* sort by it, but deliberately never rendered as a number -- it counts Open Library
   * users who shelved the book, which is not audiobook popularity and not this server's users. */
  popularity: z.number().int().nullable()
})

export const DiscoverBrowseQuerySchema = z.object({
  catalog: z.string().min(1).max(64),
  // Trimmed so a padded genre ("fantasy ") is the same genre as "fantasy" upstream, and a
  // whitespace-only one collapses to "" -- which the route already treats as "no genre".
  // `catalog` is deliberately NOT trimmed: it is an opaque id Librarr listed, never typed.
  genre: z.string().trim().max(128).optional(),
  // `offset` must be a multiple of the page size: Librarr validates this itself and a stray
  // value would come back as `invalid_request`, so reject it at the edge instead. Omission is
  // 0, but a BLANK value is a client bug and must not silently coerce to 0 -- hence the
  // explicit min length before the coercion. Decimal digits only, too: `z.coerce.number()` is
  // `Number(x)`, which reads whitespace as 0 and `0x14` as 20, so those would otherwise slip
  // through as offsets the caller never meant.
  offset: z
    .string()
    .min(1)
    .regex(/^\d+$/, { message: 'offset must be decimal digits only' })
    .optional()
    .pipe(z.coerce.number().int().min(0).max(DISCOVER_MAX_OFFSET).default(0))
    .refine((value) => value % DISCOVER_PAGE_SIZE === 0, {
      message: `offset must be a multiple of ${DISCOVER_PAGE_SIZE}`
    })
})

/**
 * A browse page as the gateway hands it to a client.
 *
 * Only the three statuses a client can act on appear here. Librarr also answers HTTP 200 with
 * `upstream_unavailable` and `rate_limited`, but those are transport failures wearing a success
 * suit, so the gateway turns them into 502 and 429 `GatewayError`s instead -- a client should
 * never have to tell "Open Library is down" from "this genre is empty" by reading a status
 * field.
 *
 * `catalog`, `genre` and `offset` are echoed from the REQUEST, not from Librarr's reply.
 * Librarr omits them entirely on its failure bodies (measured: the outage body is
 * `{status, error, items}` and nothing else), so trusting its echo would mean a success-shaped
 * schema that cannot even parse an outage. The gateway checks Librarr's echo against the
 * request when it is present and logs a mismatch, but what it reports here is what was asked
 * for.
 */
export const DiscoverBrowseResponseSchema = z.object({
  status: z.enum(['ok', 'empty', 'invalid_request']),
  catalog: z.string(),
  genre: z.string(),
  offset: z.number().int().min(0).max(DISCOVER_MAX_OFFSET),
  /** `null` means this was the last page. It is the ONLY end-of-paging signal: a short page is
   * not the end. Measured -- a `science fiction` page returned 7 items with `next_offset` still
   * 20, because Open Library drops works that fail the catalog's filters. When non-null it is
   * always greater than `offset`. */
  nextOffset: z.number().int().min(0).max(DISCOVER_MAX_OFFSET).nullable(),
  /** Librarr sets this when a ranked catalog fell back to relevance order, i.e. the page is no
   * longer the ranking it claims to be. A ranked feed should not present such a page as
   * "popular" or "top rated". */
  partial: z.boolean(),
  items: z.array(DiscoverItemSchema)
})

export const AcquisitionEventSchema = z.object({
  id: z.string(),
  type: z.enum(['acquisition.created', 'acquisition.updated']),
  acquisitionId: z.string(),
  occurredAt: z.string().datetime()
})

export type Acquisition = z.infer<typeof AcquisitionSchema>
export type AcquisitionState = z.infer<typeof AcquisitionStateSchema>
export type GatewayError = z.infer<typeof GatewayErrorSchema>
export type CreateAcquisitionBody = z.infer<typeof CreateAcquisitionBodySchema>
export type SearchRelease = z.infer<typeof SearchReleaseSchema>
export type SearchResponse = z.infer<typeof SearchResponseSchema>
export type SearchQuery = z.infer<typeof SearchQuerySchema>
export type AcquisitionEvent = z.infer<typeof AcquisitionEventSchema>
export type DiscoverOption = z.infer<typeof DiscoverOptionSchema>
export type DiscoverOptionsResponse = z.infer<typeof DiscoverOptionsResponseSchema>
export type DiscoverItem = z.infer<typeof DiscoverItemSchema>
export type DiscoverBrowseQuery = z.infer<typeof DiscoverBrowseQuerySchema>
export type DiscoverBrowseResponse = z.infer<typeof DiscoverBrowseResponseSchema>
