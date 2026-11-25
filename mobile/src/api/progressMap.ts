import type { AbsUserMediaProgress } from '../types/abs'

/**
 * Per-user progress keyed for O(1) lookup. List endpoints never attach progress to items, so
 * screens resolve it from `GET /api/me` -> `mediaProgress` through this map instead of an N+1
 * `GET /items/:id` per card.
 *
 * Key: the library item id for a book; `<libraryItemId>-<episodeId>` for a podcast episode. Use
 * [progressKey] / [getProgress] rather than building keys by hand.
 */
export type UserProgressMap = ReadonlyMap<string, AbsUserMediaProgress>

/** Stable map key for a book (`episodeId` omitted/null) or a podcast episode. */
export function progressKey(libraryItemId: string, episodeId?: string | null): string {
  return episodeId ? `${libraryItemId}-${episodeId}` : libraryItemId
}

/** Indexes `/api/me` media progress. A later row for the same key wins, matching server order. */
export function buildProgressMap(mediaProgress: readonly AbsUserMediaProgress[] | null | undefined): UserProgressMap {
  const map = new Map<string, AbsUserMediaProgress>()
  for (const entry of mediaProgress ?? []) {
    map.set(progressKey(entry.libraryItemId, entry.episodeId), entry)
  }
  return map
}

/** Progress for a book (omit `episodeId`) or an episode; undefined when never started. */
export function getProgress(map: UserProgressMap, libraryItemId: string, episodeId?: string | null): AbsUserMediaProgress | undefined {
  return map.get(progressKey(libraryItemId, episodeId))
}

export const EMPTY_PROGRESS_MAP: UserProgressMap = new Map()
