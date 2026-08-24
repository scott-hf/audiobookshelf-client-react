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
  q: z.string().min(1)
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
