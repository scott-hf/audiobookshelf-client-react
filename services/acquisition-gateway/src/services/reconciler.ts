import type { LibrarrClient } from '../adapters/librarrClient'
import type { LibrarrDownloadStatus } from '../adapters/librarrSchemas'
import { AcquisitionRepository, type AcquisitionRecord } from '../db/acquisitionRepository'
import { SearchRepository } from '../db/searchRepository'
import { normalizeInfoHash } from '../domain/releaseIdentity'
import { mayAdvance, normalizeLibrarrStatus } from '../domain/statusNormalization'

export interface ReconcilerOptions {
  librarr: LibrarrClient
  repo: AcquisitionRepository
  searchRepo?: SearchRepository
  intervalMs: number
  /** No progress past 0 bytes/0% for this many seconds while downloading moves the row to
   * failed/retryable. TorBox with download_uncached accepts any hash and can sit at 0 B
   * forever (FND-00410) -- Librarr's own status never reports this as an error. */
  stallTimeoutSeconds: number
  /** Terminal rows last updated before this many seconds ago are pruned each cycle. */
  historyRetentionSeconds?: number
  now?: () => number
  onEvent?: (acquisitionId: string) => void
}

export class Reconciler {
  private timer: ReturnType<typeof setInterval> | undefined
  private running = false
  private readonly now: () => number

  constructor(private readonly opts: ReconcilerOptions) {
    this.now = opts.now ?? Date.now
  }

  /** Single reconciliation pass: fetch Librarr's live queue, correlate every non-terminal
   * row by tracking key, apply the monotonic-advance + stall-timeout rules, then prune
   * expired search sessions and old terminal rows. Safe to call concurrently with itself
   * (a poll tick landing mid-run is a no-op) and safe to call before any mutation route is
   * enabled, per the plan's startup-catch-up requirement. */
  async runOnce(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const downloads = await this.opts.librarr.getDownloads()
      const byKey = indexByTrackingKey(downloads)
      const nonTerminal = this.opts.repo.listNonTerminal()

      for (const record of nonTerminal) {
        this.reconcileOne(record, byKey)
      }

      this.cleanup()
    } finally {
      this.running = false
    }
  }

  private reconcileOne(record: AcquisitionRecord, byKey: Map<string, LibrarrDownloadStatus>): void {
    if (!record.trackingKey) return // not yet submitted, or already needs_attention

    const status = byKey.get(record.trackingKey)
    const nowIso = new Date(this.now()).toISOString()

    if (!status) {
      // Librarr no longer reports this job. Once a row has progressed past active
      // downloading (staging/import/scan), Librarr's own /api/downloads entry naturally
      // drops off on completion -- that is expected, not a loss, so leave it alone.
      if (record.state === 'processing' || record.state === 'staged' || record.state === 'importing' || record.state === 'scanning') {
        return
      }
      this.opts.repo.update(record.id, {
        state: 'needs_attention',
        errorCode: 'librarr_job_missing',
        errorMessage: 'Librarr no longer reports this download',
        errorRetryable: true,
        updatedAt: nowIso
      })
      this.opts.onEvent?.(record.id)
      return
    }

    const { state: mapped, progressPercent } = normalizeLibrarrStatus(status)
    let nextState = mapped
    const patch: Partial<AcquisitionRecord> = { progressPercent, updatedAt: nowIso }

    if (mapped === 'downloading' && progressPercent === 0) {
      const stalledSinceMs = record.stalledSince ? new Date(record.stalledSince).getTime() : this.now()
      if (!record.stalledSince) {
        patch.stalledSince = nowIso
      } else if (this.now() - stalledSinceMs >= this.opts.stallTimeoutSeconds * 1000) {
        nextState = 'failed'
        patch.errorCode = 'download_stalled'
        patch.errorMessage = `No progress past 0 bytes for ${this.opts.stallTimeoutSeconds}s`
        patch.errorRetryable = true
      }
    } else if (record.stalledSince) {
      patch.stalledSince = null
    }

    if (status.error) {
      nextState = 'failed'
      patch.errorCode = 'librarr_download_error'
      patch.errorMessage = status.error
      patch.errorRetryable = true
    }

    if (!mayAdvance(record.state, nextState)) return

    patch.state = nextState
    if (nextState === 'submitted' || nextState === 'downloading' || nextState === 'processing') {
      patch.lastSuccessfulStage = nextState
    }
    this.opts.repo.update(record.id, patch)
    this.opts.onEvent?.(record.id)
  }

  private cleanup(): void {
    const retentionSeconds = this.opts.historyRetentionSeconds
    if (retentionSeconds === undefined) return
    const cutoff = new Date(this.now() - retentionSeconds * 1000).toISOString()
    this.opts.repo.deleteTerminalOlderThan(cutoff)
    if (this.opts.searchRepo) {
      const referenced = this.opts.repo.listNonTerminal().map((r) => r.searchSessionId)
      this.opts.searchRepo.deleteExpiredExcept(new Date(this.now()).toISOString(), referenced)
    }
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.runOnce()
    }, this.opts.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
}

function indexByTrackingKey(downloads: LibrarrDownloadStatus[]): Map<string, LibrarrDownloadStatus> {
  const byKey = new Map<string, LibrarrDownloadStatus>()
  for (const d of downloads) {
    const hash = normalizeInfoHash(d.hash)
    if (hash) byKey.set(`torrent:${hash}`, d)
    if (d.job_id) byKey.set(`job:${d.job_id}`, d)
  }
  return byKey
}
