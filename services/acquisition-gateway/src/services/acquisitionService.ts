import type { Acquisition } from '@abs/acquisition-contract'
import { LibrarrApiError, type LibrarrClient } from '../adapters/librarrClient'
import { AcquisitionRepository, type AcquisitionRecord } from '../db/acquisitionRepository'
import { DomainError } from '../domain/errors'
import { opaqueId, isRequestable } from '../domain/releaseIdentity'
import { trackingKey, trackingKeyKind, trackingKeyValue } from '../domain/librarrTrackingKey'
import type { SearchService } from './searchService'
import type { ImportCoordinator } from './importCoordinator'

/** Stages owned by the ImportCoordinator; a retry from any of these resumes the import
 * pipeline and must never reach Librarr's submit endpoint again. */
const IMPORT_STAGES = new Set(['staged', 'importing', 'scanning', 'available'])

export interface CreateAcquisitionInput {
  searchSessionId: string
  releaseId: string
  idempotencyKey: string
}

export interface AcquisitionServiceOptions {
  librarr: LibrarrClient
  repo: AcquisitionRepository
  searchService: SearchService
  /** Owns retries whose last successful stage is inside the import pipeline. */
  importCoordinator?: Pick<ImportCoordinator, 'retry'>
  now?: () => number
}

const CANCELLABLE_STATES = new Set(['queued', 'submitted', 'downloading', 'processing', 'staged', 'importing', 'scanning'])
const RETRYABLE_STATES = new Set(['failed', 'needs_attention'])

export function toPublicAcquisition(record: AcquisitionRecord): Acquisition {
  return {
    id: record.id,
    libraryId: record.absLibraryId,
    title: record.title,
    author: record.author,
    state: record.state,
    progressPercent: record.progressPercent ?? null,
    absItemId: record.absItemId ?? null,
    error: record.errorCode
      ? {
          code: record.errorCode,
          message: record.errorMessage ?? '',
          retryable: Boolean(record.errorRetryable),
          lastSuccessfulStage: record.lastSuccessfulStage ?? null
        }
      : null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  }
}

export class AcquisitionService {
  private readonly librarr: LibrarrClient
  private readonly repo: AcquisitionRepository
  private readonly searchService: SearchService
  private readonly importCoordinator?: Pick<ImportCoordinator, 'retry'>
  private readonly now: () => number

  constructor(options: AcquisitionServiceOptions) {
    this.librarr = options.librarr
    this.repo = options.repo
    this.searchService = options.searchService
    this.importCoordinator = options.importCoordinator
    this.now = options.now ?? Date.now
  }

  /**
   * Idempotent create: resolves the release and does the get-or-insert entirely
   * synchronously (see AcquisitionRepository.createIfAbsent), THEN submits to Librarr only
   * for the caller that actually won the insert. This is what makes concurrent repeats of
   * the same idempotencyKey produce exactly one Librarr submission (Gate 2 requirement).
   */
  async create(user: { id: string }, libraryId: string, input: CreateAcquisitionInput): Promise<Acquisition> {
    const { session, raw } = this.searchService.resolveRelease(user.id, input.searchSessionId, input.releaseId)
    if (session.absLibraryId !== libraryId) {
      throw new DomainError('library_mismatch', 'library_mismatch: search session belongs to a different library', false)
    }
    if (!isRequestable(raw)) {
      throw new DomainError('release_not_trackable', 'release_not_trackable: no info_hash, magnet BTIH, or abb_url', false)
    }

    const nowIso = new Date(this.now()).toISOString()
    const draft: AcquisitionRecord = {
      id: opaqueId('acq'),
      absUserId: user.id,
      absLibraryId: libraryId,
      idempotencyKey: input.idempotencyKey,
      searchSessionId: input.searchSessionId,
      releaseId: input.releaseId,
      title: raw.title,
      author: raw.author ?? '',
      format: raw.format ?? null,
      sizeBytes: raw.size ?? null,
      sourceLabel: raw.source,
      state: 'queued',
      createdAt: nowIso,
      updatedAt: nowIso
    }

    const { record, created } = this.repo.createIfAbsent(draft)
    if (!created) return toPublicAcquisition(record)

    await this.submit(record, raw)
    return toPublicAcquisition(this.repo.findById(record.id) ?? record)
  }

  private async submit(record: AcquisitionRecord, raw: Parameters<LibrarrClient['submitAudiobook']>[0]): Promise<void> {
    const updatedAt = new Date(this.now()).toISOString()
    try {
      const submitResponse = await this.librarr.submitAudiobook(raw)
      if (!submitResponse.success) {
        this.repo.update(record.id, {
          state: 'failed',
          errorCode: 'librarr_submit_rejected',
          errorMessage: submitResponse.error || 'Librarr rejected the download request',
          errorRetryable: true,
          lastSuccessfulStage: 'queued',
          updatedAt
        })
        return
      }
      const key = trackingKey(raw, submitResponse)
      if (!key) {
        this.repo.update(record.id, {
          state: 'needs_attention',
          errorCode: 'release_not_trackable',
          errorMessage: 'Librarr accepted the download but returned no stable tracking identity',
          errorRetryable: false,
          lastSuccessfulStage: 'queued',
          updatedAt
        })
        return
      }
      this.repo.update(record.id, {
        state: 'submitted',
        trackingKey: key,
        lastSuccessfulStage: 'submitted',
        updatedAt
      })
    } catch (error) {
      const isLibrarrError = error instanceof LibrarrApiError
      this.repo.update(record.id, {
        state: 'failed',
        errorCode: isLibrarrError ? error.code : 'librarr_unreachable',
        errorMessage: error instanceof Error ? error.message : 'Unknown error submitting to Librarr',
        errorRetryable: isLibrarrError ? error.code === 'librarr_error' : true,
        lastSuccessfulStage: 'queued',
        updatedAt
      })
    }
  }

  get(user: { id: string }, id: string): Acquisition {
    const record = this.findOwned(user, id)
    return toPublicAcquisition(record)
  }

  list(user: { id: string }, libraryId: string): Acquisition[] {
    return this.repo.listByUser(user.id, libraryId).map(toPublicAcquisition)
  }

  /** Retry resumes from lastSuccessfulStage. Torrent and NZB tracking keys resubmit the
   * persisted snapshot from scratch (Librarr's job-retry endpoint does not apply to
   * torrents -- WI-1496 correction #5); only a direct-download `job:` key calls Librarr's
   * own retry endpoint. A failure from any import stage is delegated to the ImportCoordinator
   * and never touches Librarr at all. */
  async retry(user: { id: string }, id: string): Promise<Acquisition> {
    const record = this.findOwned(user, id)
    if (!RETRYABLE_STATES.has(record.state)) {
      throw new DomainError('acquisition_not_retryable', 'acquisition_not_retryable: acquisition is not in a retryable state', false)
    }
    if (record.errorRetryable === false) {
      throw new DomainError('acquisition_not_retryable', 'acquisition_not_retryable: this failure is not retryable', false)
    }

    const updatedAt = new Date(this.now()).toISOString()

    // A failure inside the import pipeline resumes from its own last durable boundary: the
    // book is already downloaded (and often already moved), so re-submitting to Librarr would
    // be a pointless redownload. See docs/handoff/correlation-note.md.
    if (record.lastSuccessfulStage && IMPORT_STAGES.has(record.lastSuccessfulStage)) {
      if (!this.importCoordinator) {
        throw new DomainError('acquisition_not_retryable', 'acquisition_not_retryable: import retries are not enabled', false)
      }
      return toPublicAcquisition(await this.importCoordinator.retry(record))
    }

    if (record.trackingKey && trackingKeyKind(record.trackingKey) === 'job') {
      await this.librarr.retryJob(trackingKeyValue(record.trackingKey))
      this.repo.update(id, { state: 'submitted', errorCode: null, errorMessage: null, errorRetryable: false, updatedAt })
      return toPublicAcquisition(this.repo.findById(id)!)
    }

    // torrent:, nzb:, or never-tracked (needs_attention before any submission) -- resubmit
    // the exact original snapshot rather than calling a retry endpoint that doesn't apply.
    const { raw } = this.searchService.resolveRelease(user.id, record.searchSessionId, record.releaseId)
    this.repo.update(id, { state: 'queued', errorCode: null, errorMessage: null, errorRetryable: false, updatedAt })
    await this.submit({ ...record, state: 'queued' }, raw)
    return toPublicAcquisition(this.repo.findById(id)!)
  }

  /** Cancel calls the matching Librarr delete endpoint only for an active job:/torrent:
   * tracking key, and always preserves already-imported content -- the gateway never
   * touches staged/final files here. Best-effort on the Librarr call: a failed remote
   * delete still marks the row cancelled locally so the queue does not get stuck. */
  async cancel(user: { id: string }, id: string): Promise<Acquisition> {
    const record = this.findOwned(user, id)
    if (!CANCELLABLE_STATES.has(record.state)) {
      throw new DomainError('acquisition_not_cancellable', 'acquisition_not_cancellable: acquisition is already in a terminal state', false)
    }

    if (record.trackingKey) {
      const kind = trackingKeyKind(record.trackingKey)
      const value = trackingKeyValue(record.trackingKey)
      try {
        if (kind === 'torrent') await this.librarr.deleteTorrent(value)
        else if (kind === 'job') await this.librarr.deleteJob(value)
        // nzb: not requestable/submittable in this deployment (no SABnzbd), so a
        // tracked nzb: key should never occur; nothing to call if it somehow does.
      } catch {
        // best-effort -- fall through to mark cancelled locally regardless.
      }
    }

    this.repo.update(id, { state: 'cancelled', updatedAt: new Date(this.now()).toISOString() })
    return toPublicAcquisition(this.repo.findById(id)!)
  }

  private findOwned(user: { id: string }, id: string): AcquisitionRecord {
    const record = this.repo.findById(id)
    if (!record || record.absUserId !== user.id) {
      throw new DomainError('acquisition_not_found', 'acquisition_not_found', false)
    }
    return record
  }
}

export { AcquisitionRepository }
