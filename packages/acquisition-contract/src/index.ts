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

export type Acquisition = z.infer<typeof AcquisitionSchema>
export type AcquisitionState = z.infer<typeof AcquisitionStateSchema>
export type GatewayError = z.infer<typeof GatewayErrorSchema>
export type CreateAcquisitionBody = z.infer<typeof CreateAcquisitionBodySchema>
