import { z } from 'zod'

// Grounded in the authoritative Librarr source (work/librarr @ 1b86eb1, NOT the stale
// G:\tools\ABS\librarr or docs/handoff/reference/librarr copies -- WI-1496 correction #1):
//   internal/models/book.go:7-63   SearchResult (search response entries)
//   internal/models/book.go:188-204 DownloadRequest (submit body -- same JSON field names
//     as the overlapping SearchResult fields, so a raw snapshot entry can be POSTed back
//     verbatim as the download request)
//   internal/api/download.go:105-180 torrent submit response {success,title,error,[warning],[hash]}
//   internal/models/book.go:206-220 DownloadStatus (GET /api/downloads entries)
export const LibrarrSearchResultSchema = z
  .object({
    source: z.string(),
    title: z.string(),
    author: z.string().optional().default(''),
    size: z.number().int().nonnegative().optional(),
    seeders: z.number().int().optional(),
    format: z.string().optional(),
    // internal/models/book.go:24 is `json:"media_type,omitempty"`, and AudioBookBay's own
    // Search() (internal/search/audiobookbay.go) never sets it -- it signals "this is an
    // audiobook result" via the separate `source: "audiobook"` field instead, leaving
    // MediaType as Go's zero value and thus omitted entirely (confirmed live, WI-1496
    // t1050: every real AudioBookBay row from GET /api/search/audiobooks has no media_type
    // key at all). A required z.literal('audiobook') here rejected 100% of AudioBookBay
    // results with "invalid_literal" and let only LibriVox's rows (which do set it) through.
    // This is always the audiobook-only endpoint regardless, so don't gate on a field one
    // source happens to omit -- and nothing downstream reads media_type anyway.
    media_type: z.string().optional(),
    info_hash: z.string().optional(),
    magnet_url: z.string().optional(),
    download_url: z.string().optional(),
    download_protocol: z.enum(['torrent', 'nzb']).optional(),
    guid: z.string().optional(),
    source_id: z.string().optional(),
    cover_url: z.string().optional(),
    // AudioBookBay-specific (book.go:59 AbbURL/json:"abb_url,omitempty"). AudioBookBay search
    // results carry ONLY this field -- no info_hash/magnet_url at search time; Librarr
    // resolves the magnet from the detail page at download time (FND-00434).
    abb_url: z.string().optional(),
    in_library: z.boolean().optional().default(false),
    library_item_id: z.union([z.string(), z.number()]).optional()
  })
  .passthrough()

export const LibrarrSearchResponseSchema = z.object({
  results: z.array(LibrarrSearchResultSchema),
  search_time_ms: z.number().optional(),
  sources: z.array(z.unknown()).optional()
})

// Covers all three submit response shapes Librarr actually returns (download.go:105-180
// torrent; handleDirectDownloadReq job_id; handleNZBDownload nzo_id) -- the adapter is a
// single POST per media type, so one permissive schema is simpler than three exclusive ones.
export const LibrarrSubmitResponseSchema = z.object({
  success: z.boolean(),
  title: z.string(),
  error: z.string().optional().default(''),
  warning: z.string().optional(),
  hash: z.string().optional(),
  job_id: z.string().optional(),
  nzo_id: z.string().optional()
})

export const LibrarrDownloadStatusSchema = z.object({
  source: z.string(),
  title: z.string(),
  status: z.string(),
  progress: z.number().optional(),
  size: z.string().optional(),
  speed: z.string().optional(),
  hash: z.string().optional(),
  job_id: z.string().optional(),
  error: z.string().optional(),
  detail: z.string().optional(),
  retry_count: z.number().optional(),
  max_retries: z.number().optional()
})

export const LibrarrDownloadsResponseSchema = z.object({
  downloads: z.array(LibrarrDownloadStatusSchema)
})

export const LibrarrHealthResponseSchema = z.object({ status: z.string() }).passthrough()

// Librarr's own local library rows (internal/models/book.go:104 LibraryItem, serialized by
// internal/db/library.go:456 ItemToJSON, served by GET /api/library/audiobooks ->
// serveLocalLibraryByMediaType when ABS is unset -- internal/api/library_external.go:56-64).
//
// `source_id` is the TORRENT HASH (internal/download/watcher.go:562), which is what makes it
// joinable to the gateway's `torrent:<hash>` tracking key. `file_path` is the destination
// OrganizeAudiobook actually chose, and is the ONLY trustworthy staged path -- see
// docs/handoff/correlation-note.md sections 1-2 for why the path shape itself must not be
// inferred.
export const LibrarrLibraryItemSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    title: z.string().optional().default(''),
    author: z.string().optional().default(''),
    file_path: z.string().optional().default(''),
    original_path: z.string().optional(),
    file_size: z.number().optional(),
    file_format: z.string().optional(),
    media_type: z.string().optional(),
    source: z.string().optional(),
    source_id: z.string().optional().default(''),
    added_at: z.string().optional()
  })
  .passthrough()

export const LibrarrLibraryResponseSchema = z
  .object({
    items: z.array(LibrarrLibraryItemSchema),
    total: z.number().optional(),
    page: z.number().optional(),
    pages: z.number().optional()
  })
  .passthrough()

// Librarr's Open Library discover routes (`GET /api/discover/options` and
// `GET /api/discover/browse`), measured against the live server rather than any doc.
//
// Both routes answer HTTP 200 for every outcome and carry the real result in `status`, one of
// `ok | empty | upstream_unavailable | rate_limited | invalid_request`. The failure bodies are NOT
// the success body with an empty list: an outage arrives as `{status, error, items: []}` with no
// paging cursor. A single success-shaped schema therefore cannot parse an outage -- it throws a
// ZodError that looks like a gateway bug rather than "Open Library is down".
//
// The echo (`catalog`/`genre`/`offset`) is OPTIONAL rather than absent-on-failure: a live
// `upstream_unavailable` was measured (2026-11-25) carrying all three. It is also verbatim -- a
// genre id goes out and comes back byte for byte, spaces and apostrophes included
// (`"historical fiction"`), and a request with no genre echoes `""`. That is what lets
// `routes/discover.ts` treat a mismatched echo as a bad response instead of serving a page that
// answers a different question.

export const LibrarrDiscoverOptionSchema = z.object({
  id: z.string(),
  label: z.string()
})

export const LibrarrDiscoverOptionsResponseSchema = z.object({
  // Measured `"ok"`. Tolerated as absent so a Librarr that drops the envelope still parses.
  status: z.string().optional().default('ok'),
  error: z.string().optional().default(''),
  catalogs: z.array(LibrarrDiscoverOptionSchema),
  genres: z.array(LibrarrDiscoverOptionSchema)
})

export const LibrarrDiscoverItemSchema = z.object({
  // Open Library work key, e.g. `/works/OL17930368W`.
  key: z.string(),
  title: z.string(),
  author: z.string().nullish(),
  // `""` when Open Library has no cover (the mapper turns it into null).
  cover_url: z.string().nullish(),
  // 0 means unknown (the mapper turns it into null).
  year: z.number().nullish(),
  popularity: z.number().nullish()
})

// Every field Librarr echoes back from the request. Present on a success, absent on a failure.
const discoverEchoShape = {
  error: z.string().optional().default(''),
  catalog: z.string().optional(),
  genre: z.string().optional(),
  offset: z.number().int().optional(),
  partial: z.boolean().optional().default(false)
}

/**
 * Raw `GET /api/discover/browse` body, decoded by `status` FIRST.
 *
 * A discriminated union rather than one object with everything optional, because the two arms
 * genuinely differ in what they promise:
 *  - `ok` / `empty`: the shelf was read, so `items` is a required array and `next_offset` is
 *    the paging cursor (`null` = last page).
 *  - `upstream_unavailable` / `rate_limited` / `invalid_request`: no shelf was read, so `items` is
 *    whatever Librarr put there (measured `[]`; a Go nil slice would be `null`, which is tolerated
 *    and normalised to `[]`) and nothing else is promised -- the echoed fields are optional.
 * One optional-everything object would also parse an `ok` body missing its `items`, silently
 * rendering an empty shelf; the union makes that a parse error.
 *
 * A status Librarr adds in future is not in either arm and fails to parse on purpose: the gateway
 * must not guess whether an unknown status is a success.
 */
export const LibrarrDiscoverBrowseResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.enum(['ok', 'empty']),
    ...discoverEchoShape,
    // Absent is treated as `null` (end of paging): the safe direction, it can never loop a client.
    next_offset: z.number().int().nullish(),
    items: z.array(LibrarrDiscoverItemSchema)
  }),
  z.object({
    status: z.enum(['upstream_unavailable', 'rate_limited', 'invalid_request']),
    ...discoverEchoShape,
    next_offset: z.number().int().nullish(),
    items: z
      .array(LibrarrDiscoverItemSchema)
      .nullish()
      .transform((items) => items ?? [])
  })
])

export type LibrarrDiscoverBrowseRaw = z.infer<typeof LibrarrDiscoverBrowseResponseSchema>
export type LibrarrDiscoverStatus = LibrarrDiscoverBrowseRaw['status']

export type LibrarrLibraryItem = z.infer<typeof LibrarrLibraryItemSchema>

export type LibrarrSearchResult = z.infer<typeof LibrarrSearchResultSchema>
export type LibrarrSubmitResponse = z.infer<typeof LibrarrSubmitResponseSchema>
export type LibrarrDownloadStatus = z.infer<typeof LibrarrDownloadStatusSchema>
