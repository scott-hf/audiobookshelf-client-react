import type { LibrarrClient } from '../adapters/librarrClient'
import type { LibrarrDownloadStatus } from '../adapters/librarrSchemas'
import { AcquisitionRepository, type AcquisitionRecord } from '../db/acquisitionRepository'
import { SearchRepository } from '../db/searchRepository'
import { normalizeInfoHash } from '../domain/releaseIdentity'
import { mayAdvance, normalizeLibrarrStatus } from '../domain/statusNormalization'
import type { ImportCoordinator } from './importCoordinator'

/** States the ImportCoordinator owns once Librarr's own work is finished. */
const IMPORT_STATES = new Set(['processing', 'staged', 'importing', 'scanning'])

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
  /** Drives processing -> staged -> importing -> scanning -> available. Optional so the
   * reconciler stays testable in isolation; without it a row simply parks in `processing`. */
  importCoordinator?: ImportCoordinator
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

      await this.advanceImports()

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

  /**
   * Hands every row Librarr is done with to the import coordinator. Runs after the Librarr
   * correlation pass so a row that only just reached `processing` is picked up in the same
   * cycle. Each row is isolated: one book's import failure never stops another's.
   */
  private async advanceImports(): Promise<void> {
    const coordinator = this.opts.importCoordinator
    if (!coordinator) return
    for (const record of this.opts.repo.listNonTerminal()) {
      if (!IMPORT_STATES.has(record.state)) continue
      try {
        await coordinator.advance(record)
      } catch {
        // advance() already persists its own failure states; a throw here would only be an
        // unexpected bug, and must not abort the remaining rows.
      }
    }
  }

  private cleanup(): void {
    const retentionSeconds = this.opts.historyRetentionSeconds
    if (retentionSeconds === undefined) return
    const cutoff = new Date(this.now() - retentionSeconds * 1000).toISOString()
    this.opts.repo.deleteTerminalOlderThan(cutoff)
    if (this.opts.searchRepo) {
      // Must include terminal rows, not just listNonTerminal(): an `available`/`failed`
      // acquisition still holds a FOREIGN KEY on its search_session_id until it ages out of
      // history retention (days), long after the search session's own TTL (minutes) expires.
      // Excluding terminal rows here let deleteExpiredExcept try to delete a still-referenced
      // session and crash the whole process on SQLITE_CONSTRAINT_FOREIGNKEY.
      const referenced = this.opts.repo.listSearchSessionIds()
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
