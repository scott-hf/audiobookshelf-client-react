import fsp from 'node:fs/promises'
import path from 'node:path'
import type { AcquisitionState } from '@abs/acquisition-contract'
import type { AbsAdminClient } from '../adapters/absAdminClient'
import type { LibrarrClient } from '../adapters/librarrClient'
import type { AcquisitionRecord, AcquisitionRepository } from '../db/acquisitionRepository'
import { DomainError } from '../domain/errors'
import { trackingKeyKind, trackingKeyValue } from '../domain/librarrTrackingKey'
import { assertRealPathUnder, bookDestination, destinationSuffix } from '../domain/safePath'
import type { FileHandoff, FsAdapter } from './fileHandoff'
import { resolveImportedItem } from './importResolver'
import type { StagingInspector } from './stagingInspector'

export interface ImportCoordinatorOptions {
  repo: AcquisitionRepository
  librarr: Pick<LibrarrClient, 'getAllLibraryAudiobooks' | 'deleteLibraryAudiobook'>
  abs: Pick<AbsAdminClient, 'scanLibrary' | 'listAllLibraryItems'>
  inspector: StagingInspector
  handoff: FileHandoff
  /** Same adapter the handoff uses -- the coordinator needs existence/fingerprint/remove
   * checks of its own for destination reconciliation and post-import cleanup. */
  fs: FsAdapter
  /** ABS library id -> final root, from LIBRARY_MAPPINGS_JSON. */
  libraries: Map<string, string>
  /** How long a row may sit in `processing` without a stable staged tree before it becomes
   * needs_attention. Reuses the reconciler's stall budget and the same `stalledSince` column;
   * the two never overlap because they apply to disjoint states. */
  stallTimeoutSeconds: number
  cleanupEnabled?: boolean
  /** `preserve` (default) keeps the modes Librarr wrote -- 0644 files inside 0755 dirs
   * (FND-00413), already readable by ABS. `override` applies the two modes below, for
   * deployments where ABS runs as a different uid. correlation-note.md section 4. */
  finalTreeMode?: 'preserve' | 'override'
  finalTreeFileMode?: number
  finalTreeDirMode?: number
  now?: () => number
  onEvent?: (acquisitionId: string) => void
  log?: { warn: (obj: unknown, msg: string) => void }
}

/** States this coordinator owns. Everything earlier belongs to the Reconciler. */
const OWNED_STATES = new Set<AcquisitionState>(['processing', 'staged', 'importing', 'scanning'])

const TERMINAL_STATES = new Set<AcquisitionState>(['available', 'failed', 'cancelled'])

/**
 * Drives an acquisition from `processing` (Librarr says the download is done) to `available`
 * (exactly one ABS item id resolved), persisting a durable recovery boundary before and after
 * every non-idempotent side effect.
 *
 * The coordinator NEVER calls Librarr's submit/download endpoints -- a failure anywhere in
 * this pipeline must never cause a redownload, only a resume from `lastSuccessfulStage`.
 *
 * Correlation follows docs/handoff/correlation-note.md: the staged path comes from Librarr's
 * own recorded `file_path`, looked up by `source_id` == this acquisition's torrent hash. It is
 * never inferred from a `<Author>/<Title>` (or `<Title>/<Author>`) path convention, because
 * Librarr derives those segments from a positional split of the release name.
 */
export class ImportCoordinator {
  private readonly now: () => number

  constructor(private readonly opts: ImportCoordinatorOptions) {
    this.now = opts.now ?? Date.now
  }

  /** Runs as many stages as can currently make progress. Safe to call repeatedly. */
  async advance(record: AcquisitionRecord): Promise<AcquisitionRecord> {
    let current = record
    for (let guard = 0; guard < 8; guard += 1) {
      if (!OWNED_STATES.has(current.state)) return current
      const before = current.state
      try {
        current = await this.step(current)
      } catch (error) {
        return this.persistFailure(current, error)
      }
      if (current.state === before) return current // waiting on something external
    }
    return current
  }

  /**
   * Resumes a failed/needs_attention import from its last durable boundary. Never re-enters a
   * stage that already completed, so a scan failure costs one scan, not one download.
   */
  async retry(record: AcquisitionRecord): Promise<AcquisitionRecord> {
    const resumeAt = nextStateAfter(record.lastSuccessfulStage)
    if (!resumeAt) return record
    const patched = this.persist(record, {
      state: resumeAt,
      errorCode: null,
      errorMessage: null,
      errorRetryable: false,
      completedAt: null,
      stalledSince: null,
      // Resuming the scan stage means asking ABS to scan again -- the previous attempt is
      // exactly what failed or came up empty.
      ...(resumeAt === 'scanning' ? { scanStartedAt: null } : {})
    })
    return this.advance(patched)
  }

  private async step(record: AcquisitionRecord): Promise<AcquisitionRecord> {
    switch (record.state) {
      case 'processing':
        return this.inspectAndPersistStaged(record)
      case 'staged':
        return this.persistImportingThenHandoff(record)
      case 'importing':
        return this.reconcileDestinationThenPersistScanning(record)
      case 'scanning':
        return this.scanAndResolve(record)
      default:
        return record
    }
  }

  // --- processing -> staged -------------------------------------------------------------

  private async inspectAndPersistStaged(record: AcquisitionRecord): Promise<AcquisitionRecord> {
    const located = record.stagingPath ? { filePath: record.stagingPath, itemId: record.librarrLibraryItemId ?? null } : await this.locateStagedTree(record)

    if (!located) return this.waitOrGiveUp(record, 'staging_not_found', 'Librarr reported no library row for this download yet')

    const observation = await this.opts.inspector.observe(located.filePath)
    if (!observation.stable) {
      return this.waitOrGiveUp(record, 'staging_unstable', 'Staged tree is still changing')
    }

    await assertRealPathUnder(path.dirname(observation.root), observation.root)
    const fingerprint = await this.opts.fs.contentFingerprint(observation.root)

    return this.persist(record, {
      state: 'staged',
      lastSuccessfulStage: 'staged',
      stagingPath: observation.root,
      stagingFingerprint: fingerprint,
      librarrLibraryItemId: located.itemId,
      stalledSince: null,
      progressPercent: 100
    })
  }

  /**
   * Primary correlation (correlation-note.md s.2): Librarr's local library row whose
   * `source_id` equals this acquisition's torrent hash carries the authoritative `file_path`.
   * Only torrent-tracked acquisitions can correlate this way; anything else is routed to
   * needs_attention rather than guessed at.
   */
  private async locateStagedTree(record: AcquisitionRecord): Promise<{ filePath: string; itemId: string | null } | null> {
    if (!record.trackingKey || trackingKeyKind(record.trackingKey) !== 'torrent') return null
    const hash = trackingKeyValue(record.trackingKey).toLowerCase()

    const items = await this.opts.librarr.getAllLibraryAudiobooks()
    const matches = items.filter((item) => (item.source_id ?? '').toLowerCase() === hash && item.file_path)
    if (matches.length === 0) return null
    if (matches.length > 1) {
      throw new DomainError('staging_ambiguous', 'staging_ambiguous: Librarr reports several library rows for this download', false)
    }
    return { filePath: matches[0].file_path, itemId: String(matches[0].id) }
  }

  // --- staged -> importing --------------------------------------------------------------

  /**
   * Persists `importing` AND the chosen destination BEFORE touching the filesystem, so a crash
   * mid-move is recoverable: the `importing` handler knows exactly which destination to
   * reconcile against.
   */
  private async persistImportingThenHandoff(record: AcquisitionRecord): Promise<AcquisitionRecord> {
    const root = this.libraryRoot(record)
    let destination = bookDestination(root, record.author, record.title)

    // Deterministic ` [<prefix>]` suffix, but only when the plain destination is occupied by
    // something that is not this acquisition (02-SETTLED-DECISIONS.md).
    if (record.finalPath) {
      destination = record.finalPath
    } else if (await this.destinationTakenByAnother(destination, record)) {
      destination = bookDestination(root, record.author, record.title, destinationSuffix(record.id))
    }

    await assertRealPathUnder(root, destination)

    const importing = this.persist(record, { state: 'importing', lastSuccessfulStage: 'importing', finalPath: destination })
    return this.reconcileDestinationThenPersistScanning(importing)
  }

  private async destinationTakenByAnother(destination: string, record: AcquisitionRecord): Promise<boolean> {
    const fs = this.opts.fs
    if (!(await fs.exists(destination))) return false
    if (!record.stagingFingerprint) return true
    return (await fs.contentFingerprint(destination)) !== record.stagingFingerprint
  }

  // --- importing -> scanning ------------------------------------------------------------

  private async reconcileDestinationThenPersistScanning(record: AcquisitionRecord): Promise<AcquisitionRecord> {
    if (!record.finalPath || !record.stagingPath) {
      throw new DomainError('import_state_incomplete', 'import_state_incomplete: importing row has no staging/final path', false)
    }

    await this.opts.handoff.move({
      source: record.stagingPath,
      destination: record.finalPath,
      acquisitionId: record.id,
      expectedFingerprint: record.stagingFingerprint ?? undefined
    })
    this.opts.inspector.forget(record.stagingPath)
    await this.applyFinalTreeModes(record.finalPath)

    // The book is now safely in place. The scan itself belongs to the `scanning` stage, so a
    // resume from `scanning` re-triggers it -- a scan failure must be retryable without
    // redoing the handoff.
    return this.persist(record, { state: 'scanning', lastSuccessfulStage: 'scanning', scanStartedAt: null, stalledSince: null })
  }

  /** No-op under the default `preserve` mode. */
  private async applyFinalTreeModes(root: string): Promise<void> {
    if (this.opts.finalTreeMode !== 'override') return
    const fileMode = this.opts.finalTreeFileMode ?? 0o644
    const dirMode = this.opts.finalTreeDirMode ?? 0o755
    const walk = async (target: string): Promise<void> => {
      const stat = await fsp.lstat(target)
      if (stat.isDirectory()) {
        await fsp.chmod(target, dirMode)
        for (const entry of await fsp.readdir(target)) await walk(path.join(target, entry))
        return
      }
      await fsp.chmod(target, fileMode)
    }
    try {
      await walk(root)
    } catch (error) {
      // Mode adjustment is a convenience, never a reason to fail an otherwise-good import;
      // ABS can already read what Librarr wrote under the default preserve policy.
      this.opts.log?.warn({ err: error, root }, 'failed to apply final tree modes')
    }
  }

  // --- scanning -> available ------------------------------------------------------------

  private async scanAndResolve(record: AcquisitionRecord): Promise<AcquisitionRecord> {
    if (!record.finalPath) {
      throw new DomainError('import_state_incomplete', 'import_state_incomplete: scanning row has no final path', false)
    }
    let current = record
    if (!current.scanStartedAt) {
      // Persist the scan window BEFORE the POST: a crash after it still finds the row in
      // `scanning` with a window set, and the next pass polls instead of re-scanning.
      current = this.persist(current, { scanStartedAt: new Date(this.now()).toISOString(), stalledSince: null })
      await this.opts.abs.scanLibrary(current.absLibraryId)
    }

    const items = await this.opts.abs.listAllLibraryItems(current.absLibraryId)
    let resolved
    try {
      resolved = resolveImportedItem(
        {
          libraryId: current.absLibraryId,
          finalPath: current.finalPath!,
          title: current.title,
          author: current.author,
          scanStartedAt: current.scanStartedAt ? Date.parse(current.scanStartedAt) : undefined
        },
        items
      )
    } catch (error) {
      // ABS scanning is asynchronous: POST /scan returns immediately and the item appears
      // some time later. "Not there yet" must therefore be a wait, not a failure -- but a
      // bounded one, so a book ABS will never index still ends up in front of a human.
      if (error instanceof DomainError && error.code === 'import_not_resolved') {
        return this.waitOrGiveUp(current, 'import_not_resolved', 'Audiobookshelf has not indexed the imported book yet')
      }
      throw error
    }
    record = current

    const available = this.persist(record, {
      state: 'available',
      lastSuccessfulStage: 'available',
      absItemId: resolved.id,
      progressPercent: 100,
      errorCode: null,
      errorMessage: null,
      errorRetryable: false,
      completedAt: new Date(this.now()).toISOString()
    })

    await this.cleanupAfterConfirmedImport(available)
    return available
  }

  /**
   * Post-import cleanup (correlation-note.md s.6). Both halves are mandatory and prompt:
   * a leftover staged tree is re-registered by Librarr's startup folder scanner (FND-00414),
   * and a leftover Librarr library row blocks re-acquisition through `in_library` dedupe.
   *
   * Best-effort with respect to state: the acquisition is already `available`, and settled
   * decisions forbid regressing a persisted lifecycle state, so a cleanup failure is logged
   * rather than allowed to undo a successful import.
   */
  private async cleanupAfterConfirmedImport(record: AcquisitionRecord): Promise<void> {
    if (this.opts.cleanupEnabled === false) return

    if (record.stagingPath) {
      try {
        const fs = this.opts.fs
        if (await fs.exists(record.stagingPath)) await fs.rm(record.stagingPath)
      } catch (error) {
        this.opts.log?.warn({ err: error, acquisitionId: record.id }, 'failed to remove staged tree after import')
      }
    }

    if (record.librarrLibraryItemId) {
      try {
        await this.opts.librarr.deleteLibraryAudiobook(record.librarrLibraryItemId)
        this.persist(record, { librarrLibraryItemId: null })
      } catch (error) {
        this.opts.log?.warn({ err: error, acquisitionId: record.id }, 'failed to delete stale Librarr library row after import')
      }
    }
  }

  // --- shared --------------------------------------------------------------------------

  private libraryRoot(record: AcquisitionRecord): string {
    const root = this.opts.libraries.get(record.absLibraryId)
    if (!root) {
      throw new DomainError('library_not_mapped', `library_not_mapped: no final root configured for ${record.absLibraryId}`, false)
    }
    return root
  }

  /** Stays put until the stall budget runs out, then gives up to needs_attention. */
  private waitOrGiveUp(record: AcquisitionRecord, code: string, message: string): AcquisitionRecord {
    const nowIso = new Date(this.now()).toISOString()
    if (!record.stalledSince) {
      return this.persist(record, { stalledSince: nowIso })
    }
    if (this.now() - Date.parse(record.stalledSince) < this.opts.stallTimeoutSeconds * 1000) return record
    return this.persist(record, {
      state: 'needs_attention',
      errorCode: code,
      errorMessage: message,
      errorRetryable: true
    })
  }

  private persistFailure(record: AcquisitionRecord, error: unknown): AcquisitionRecord {
    const domain = error instanceof DomainError ? error : null
    // A non-retryable domain failure needs a human (ambiguity, a foreign directory at the
    // destination); everything else is a retryable failure the user can resume.
    const state: AcquisitionState = domain && !domain.retryable ? 'needs_attention' : 'failed'
    return this.persist(record, {
      state,
      errorCode: domain?.code ?? codeOf(error),
      errorMessage: error instanceof Error ? error.message : 'Unknown import failure',
      errorRetryable: domain ? domain.retryable : true
    })
  }

  private persist(record: AcquisitionRecord, patch: Partial<AcquisitionRecord>): AcquisitionRecord {
    const full: Partial<AcquisitionRecord> = { ...patch, updatedAt: new Date(this.now()).toISOString() }
    if (full.state && TERMINAL_STATES.has(full.state) && full.completedAt === undefined) {
      full.completedAt = full.updatedAt
    }
    this.opts.repo.update(record.id, full)
    const next = this.opts.repo.findById(record.id) ?? ({ ...record, ...full } as AcquisitionRecord)
    if (patch.state && patch.state !== record.state) this.opts.onEvent?.(record.id)
    return next
  }
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'import_failed'
}

/** Where `retry` resumes from, given the last stage that fully succeeded. */
function nextStateAfter(lastSuccessfulStage: string | null | undefined): AcquisitionState | null {
  switch (lastSuccessfulStage) {
    case 'scanning':
    case 'available':
      return 'scanning'
    case 'importing':
      return 'importing'
    case 'staged':
      return 'staged'
    case 'processing':
    case 'downloading':
      return 'processing'
    default:
      return null
  }
}
