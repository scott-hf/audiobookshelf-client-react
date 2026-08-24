import { z } from 'zod'

// Grounded in the reference-only Audiobookshelf server checkout (G:\tools\ABS\audiobookshelf,
// never modified by this work):
//   server/routers/ApiRouter.js:91          POST /api/libraries/:id/scan
//   server/models/LibraryItem.js:1012-1038  toOldJSONMinified() -- id/libraryId/path/relPath/
//                                           addedAt(ms)/updatedAt(ms)/mediaType/media
//   server/models/Book.js:655-675           Book.toOldJSONMinified() -- { id, metadata, ... }
//   server/models/Book.js:587-607           oldMetadataToJSONMinified() -- title/authorName/
//                                           isbn/asin/...
//   server/controllers/LibraryController.js:611-638 items envelope
//                                           { results, total, limit, page, sortBy, minified }
//
// Every object is passthrough: ABS adds fields across releases and an unknown extra key must
// never fail an import. Missing/renamed REQUIRED keys still fail loudly (schema drift).

export const AbsBookMetadataSchema = z
  .object({
    title: z.string().nullable().optional(),
    subtitle: z.string().nullable().optional(),
    authorName: z.string().nullable().optional(),
    narratorName: z.string().nullable().optional(),
    seriesName: z.string().nullable().optional(),
    isbn: z.string().nullable().optional(),
    asin: z.string().nullable().optional()
  })
  .passthrough()

export const AbsMediaSchema = z
  .object({
    id: z.string().optional(),
    metadata: AbsBookMetadataSchema.optional()
  })
  .passthrough()

export const AbsLibraryItemSchema = z
  .object({
    id: z.string(),
    libraryId: z.string(),
    path: z.string(),
    relPath: z.string().optional(),
    // ABS serializes these as epoch milliseconds (Date.valueOf()), not ISO strings.
    addedAt: z.number().optional(),
    updatedAt: z.number().optional(),
    mediaType: z.string().optional(),
    media: AbsMediaSchema.optional()
  })
  .passthrough()

export const AbsLibraryItemsResponseSchema = z
  .object({
    results: z.array(AbsLibraryItemSchema),
    total: z.number().optional(),
    limit: z.number().optional(),
    page: z.number().optional()
  })
  .passthrough()

export type AbsBookMetadata = z.infer<typeof AbsBookMetadataSchema>
export type AbsLibraryItem = z.infer<typeof AbsLibraryItemSchema>
export type AbsLibraryItemsResponse = z.infer<typeof AbsLibraryItemsResponseSchema>
