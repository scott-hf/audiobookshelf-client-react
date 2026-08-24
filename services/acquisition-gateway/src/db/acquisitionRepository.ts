import type Database from 'better-sqlite3'
import type { AcquisitionState } from '@abs/acquisition-contract'

export interface AcquisitionRecord {
  id: string
  absUserId: string
  absLibraryId: string
  idempotencyKey: string
  searchSessionId: string
  releaseId: string
  /** Prefixed correlation key: "torrent:<hash>" | "job:<id>" | "nzb:<id>". Null while
   * unsubmitted or when Librarr gave the gateway nothing trackable (needs_attention). */
  trackingKey?: string | null
  title: string
  author: string
  narratorsJson?: string
  format?: string | null
  sizeBytes?: number | null
  sourceLabel?: string | null
  state: AcquisitionState
  progressPercent?: number | null
  stagingPath?: string | null
  finalPath?: string | null
  absItemId?: string | null
  errorCode?: string | null
  errorMessage?: string | null
  errorRetryable?: boolean
  lastSuccessfulStage?: string | null
  /** Set the first time the reconciler observes 0 bytes/0% progress on a downloading row;
   * cleared once progress advances. Backs the stall-timeout policy (FND-00410). */
  stalledSince?: string | null
  createdAt: string
  updatedAt: string
  completedAt?: string | null
}

interface AcquisitionRow {
  id: string
  abs_user_id: string
  abs_library_id: string
  idempotency_key: string
  search_session_id: string
  release_id: string
  tracking_key: string | null
  title: string
  author: string
  narrators_json: string
  format: string | null
  size_bytes: number | null
  source_label: string | null
  state: string
  progress_percent: number | null
  staging_path: string | null
  final_path: string | null
  abs_item_id: string | null
  error_code: string | null
  error_message: string | null
  error_retryable: number
  last_successful_stage: string | null
  stalled_since: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

const TERMINAL_STATES: AcquisitionState[] = ['available', 'failed', 'cancelled']

function rowToRecord(row: AcquisitionRow): AcquisitionRecord {
  return {
    id: row.id,
    absUserId: row.abs_user_id,
    absLibraryId: row.abs_library_id,
    idempotencyKey: row.idempotency_key,
    searchSessionId: row.search_session_id,
    releaseId: row.release_id,
    trackingKey: row.tracking_key,
    title: row.title,
    author: row.author,
    narratorsJson: row.narrators_json,
    format: row.format,
    sizeBytes: row.size_bytes,
    sourceLabel: row.source_label,
    state: row.state as AcquisitionState,
    progressPercent: row.progress_percent,
    stagingPath: row.staging_path,
    finalPath: row.final_path,
    absItemId: row.abs_item_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    errorRetryable: Boolean(row.error_retryable),
    lastSuccessfulStage: row.last_successful_stage,
    stalledSince: row.stalled_since,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  }
}

/** Whitelisted, snake_case-mapped fields `update()` may write. Keeps the SET clause safe
 * against arbitrary keys while letting every call site pass a partial record. */
const UPDATABLE_FIELDS: Record<string, string> = {
  trackingKey: 'tracking_key',
  state: 'state',
  progressPercent: 'progress_percent',
  stagingPath: 'staging_path',
  finalPath: 'final_path',
  absItemId: 'abs_item_id',
  errorCode: 'error_code',
  errorMessage: 'error_message',
  errorRetryable: 'error_retryable',
  lastSuccessfulStage: 'last_successful_stage',
  stalledSince: 'stalled_since',
  updatedAt: 'updated_at',
  completedAt: 'completed_at'
}

export class AcquisitionRepository {
  constructor(private readonly db: Database.Database) {}

  create(record: AcquisitionRecord): void {
    this.db
      .prepare(
        `INSERT INTO acquisitions (
          id, abs_user_id, abs_library_id, idempotency_key, search_session_id, release_id,
          tracking_key, title, author, narrators_json, format, size_bytes, source_label,
          state, progress_percent, staging_path, final_path, abs_item_id, error_code,
          error_message, error_retryable, last_successful_stage, stalled_since, created_at, updated_at, completed_at
        ) VALUES (
          @id, @absUserId, @absLibraryId, @idempotencyKey, @searchSessionId, @releaseId,
          @trackingKey, @title, @author, @narratorsJson, @format, @sizeBytes, @sourceLabel,
          @state, @progressPercent, @stagingPath, @finalPath, @absItemId, @errorCode,
          @errorMessage, @errorRetryable, @lastSuccessfulStage, @stalledSince, @createdAt, @updatedAt, @completedAt
        )`
      )
      .run(this.toParams(record))
  }

  /**
   * Atomically returns the existing row for (absUserId, idempotencyKey) or inserts `record`
   * and returns it. Relies on better-sqlite3 being fully synchronous: this method runs to
   * completion with no I/O yield point, so two `Promise.all`-concurrent callers into the
   * owning service never interleave inside it -- the second sees the first's row via
   * `INSERT OR IGNORE` + the UNIQUE(abs_user_id, idempotency_key) constraint (WI-1496 Gate 2
   * concurrent-idempotency requirement).
   */
  createIfAbsent(record: AcquisitionRecord): { record: AcquisitionRecord; created: boolean } {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO acquisitions (
          id, abs_user_id, abs_library_id, idempotency_key, search_session_id, release_id,
          tracking_key, title, author, narrators_json, format, size_bytes, source_label,
          state, progress_percent, staging_path, final_path, abs_item_id, error_code,
          error_message, error_retryable, last_successful_stage, stalled_since, created_at, updated_at, completed_at
        ) VALUES (
          @id, @absUserId, @absLibraryId, @idempotencyKey, @searchSessionId, @releaseId,
          @trackingKey, @title, @author, @narratorsJson, @format, @sizeBytes, @sourceLabel,
          @state, @progressPercent, @stagingPath, @finalPath, @absItemId, @errorCode,
          @errorMessage, @errorRetryable, @lastSuccessfulStage, @stalledSince, @createdAt, @updatedAt, @completedAt
        )`
      )
      .run(this.toParams(record))
    if (info.changes === 1) return { record, created: true }
    const existing = this.findByIdempotencyKey(record.absUserId, record.idempotencyKey)
    if (!existing) throw new Error('createIfAbsent: insert was ignored but no existing row was found')
    return { record: existing, created: false }
  }

  private toParams(record: AcquisitionRecord): Record<string, unknown> {
    return {
      trackingKey: null,
      narratorsJson: '[]',
      format: null,
      sizeBytes: null,
      sourceLabel: null,
      progressPercent: null,
      stagingPath: null,
      finalPath: null,
      absItemId: null,
      errorCode: null,
      errorMessage: null,
      lastSuccessfulStage: null,
      stalledSince: null,
      completedAt: null,
      ...record,
      errorRetryable: record.errorRetryable ? 1 : 0
    }
  }

  update(id: string, patch: Partial<AcquisitionRecord>): void {
    const entries = Object.entries(patch).filter(([key]) => key in UPDATABLE_FIELDS)
    if (entries.length === 0) return
    const setClause = entries.map(([key]) => `${UPDATABLE_FIELDS[key]} = @${key}`).join(', ')
    const params: Record<string, unknown> = { id }
    for (const [key, value] of entries) {
      params[key] = key === 'errorRetryable' ? (value ? 1 : 0) : value
    }
    this.db.prepare(`UPDATE acquisitions SET ${setClause} WHERE id = @id`).run(params)
  }

  findById(id: string): AcquisitionRecord | undefined {
    const row = this.db.prepare('SELECT * FROM acquisitions WHERE id = ?').get(id) as AcquisitionRow | undefined
    return row ? rowToRecord(row) : undefined
  }

  findByIdempotencyKey(absUserId: string, idempotencyKey: string): AcquisitionRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM acquisitions WHERE abs_user_id = ? AND idempotency_key = ?')
      .get(absUserId, idempotencyKey) as AcquisitionRow | undefined
    return row ? rowToRecord(row) : undefined
  }

  findByTrackingKey(trackingKey: string): AcquisitionRecord | undefined {
    const row = this.db.prepare('SELECT * FROM acquisitions WHERE tracking_key = ?').get(trackingKey) as
      | AcquisitionRow
      | undefined
    return row ? rowToRecord(row) : undefined
  }

  listByUser(absUserId: string, absLibraryId: string): AcquisitionRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM acquisitions WHERE abs_user_id = ? AND abs_library_id = ? ORDER BY updated_at DESC')
      .all(absUserId, absLibraryId) as AcquisitionRow[]
    return rows.map(rowToRecord)
  }

  /** All rows the reconciler must catch up on restart / poll: anything not yet in a terminal
   * state (available, failed, cancelled). */
  listNonTerminal(): AcquisitionRecord[] {
    const placeholders = TERMINAL_STATES.map(() => '?').join(', ')
    const rows = this.db
      .prepare(`SELECT * FROM acquisitions WHERE state NOT IN (${placeholders})`)
      .all(...TERMINAL_STATES) as AcquisitionRow[]
    return rows.map(rowToRecord)
  }

  /** Deletes terminal rows last updated before `cutoffIso` (history retention). */
  deleteTerminalOlderThan(cutoffIso: string): number {
    const placeholders = TERMINAL_STATES.map(() => '?').join(', ')
    const info = this.db
      .prepare(`DELETE FROM acquisitions WHERE state IN (${placeholders}) AND updated_at < ?`)
      .run(...TERMINAL_STATES, cutoffIso)
    return info.changes
  }
}
