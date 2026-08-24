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

export type LibrarrLibraryItem = z.infer<typeof LibrarrLibraryItemSchema>

export type LibrarrSearchResult = z.infer<typeof LibrarrSearchResultSchema>
export type LibrarrSubmitResponse = z.infer<typeof LibrarrSubmitResponseSchema>
export type LibrarrDownloadStatus = z.infer<typeof LibrarrDownloadStatusSchema>
