import type Database from 'better-sqlite3'
import type { AcquisitionState } from '@abs/acquisition-contract'

export interface AcquisitionRecord {
  id: string
  absUserId: string
  absLibraryId: string
  idempotencyKey: string
  searchSessionId: string
  releaseId: string
  librarrJobId?: string | null
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
  librarr_job_id: string | null
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
  created_at: string
  updated_at: string
  completed_at: string | null
}

function rowToRecord(row: AcquisitionRow): AcquisitionRecord {
  return {
    id: row.id,
    absUserId: row.abs_user_id,
    absLibraryId: row.abs_library_id,
    idempotencyKey: row.idempotency_key,
    searchSessionId: row.search_session_id,
    releaseId: row.release_id,
    librarrJobId: row.librarr_job_id,
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  }
}

export class AcquisitionRepository {
  constructor(private readonly db: Database.Database) {}

  create(record: AcquisitionRecord): void {
    this.db
      .prepare(
        `INSERT INTO acquisitions (
          id, abs_user_id, abs_library_id, idempotency_key, search_session_id, release_id,
          librarr_job_id, title, author, narrators_json, format, size_bytes, source_label,
          state, progress_percent, staging_path, final_path, abs_item_id, error_code,
          error_message, error_retryable, last_successful_stage, created_at, updated_at, completed_at
        ) VALUES (
          @id, @absUserId, @absLibraryId, @idempotencyKey, @searchSessionId, @releaseId,
          @librarrJobId, @title, @author, @narratorsJson, @format, @sizeBytes, @sourceLabel,
          @state, @progressPercent, @stagingPath, @finalPath, @absItemId, @errorCode,
          @errorMessage, @errorRetryable, @lastSuccessfulStage, @createdAt, @updatedAt, @completedAt
        )`
      )
      .run({
        librarrJobId: null,
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
        completedAt: null,
        ...record,
        errorRetryable: record.errorRetryable ? 1 : 0
      })
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

  listByUser(absUserId: string, absLibraryId: string): AcquisitionRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM acquisitions WHERE abs_user_id = ? AND abs_library_id = ? ORDER BY updated_at DESC'
      )
      .all(absUserId, absLibraryId) as AcquisitionRow[]
    return rows.map(rowToRecord)
  }
}
