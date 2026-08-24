import type { AcquisitionState } from '@abs/acquisition-contract'

/** Librarr DownloadStatus.status (internal/models/book.go:207-220, DownloadJob.Status
 * comment book.go:89) -> gateway AcquisitionState. Any unmapped/unknown provider status
 * lands in needs_attention rather than silently staying put or guessing a state. */
const STATUS_MAP: Record<string, AcquisitionState> = {
  queued: 'submitted',
  searching: 'submitted',
  downloading: 'downloading',
  retry_wait: 'downloading',
  importing: 'processing',
  completed: 'processing',
  error: 'failed',
  dead_letter: 'failed'
}

export interface NormalizedStatus {
  state: AcquisitionState
  progressPercent: number
}

export function normalizeLibrarrStatus(status: { status: string; progress?: number }): NormalizedStatus {
  const state = STATUS_MAP[status.status] ?? 'needs_attention'
  const raw = status.progress ?? 0
  const progressPercent = Math.min(100, Math.max(0, raw))
  return { state, progressPercent }
}

/** Rank order for the "may only move forward" reconciliation rule -- a regressive provider
 * status report must never move a row backward in the pipeline. failed/needs_attention/
 * cancelled are always reachable (from any non-terminal state) since they represent giving
 * up, not progress. */
const RANKS: Partial<Record<AcquisitionState, number>> = {
  queued: 0,
  submitted: 1,
  downloading: 2,
  processing: 3,
  staged: 4,
  importing: 5,
  scanning: 6,
  available: 7
}

export function mayAdvance(from: AcquisitionState, to: AcquisitionState): boolean {
  if (to === 'failed' || to === 'needs_attention' || to === 'cancelled') return true
  if (from === 'failed' || from === 'cancelled' || from === 'available') return false
  const fromRank = RANKS[from]
  const toRank = RANKS[to]
  if (fromRank === undefined || toRank === undefined) return false
  return toRank >= fromRank
}
