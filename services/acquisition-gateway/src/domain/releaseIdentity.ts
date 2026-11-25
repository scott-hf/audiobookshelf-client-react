import { randomBytes } from 'node:crypto'
import type { LibrarrSearchResult } from '../adapters/librarrSchemas'
import type { SearchRelease } from '@abs/acquisition-contract'

export function opaqueId(prefix: 'search' | 'release' | 'acq'): string {
  return `${prefix}_${randomBytes(16).toString('base64url')}`
}

const BTIH_RE = /xt=urn:btih:([a-zA-Z0-9]{32,40})/i

export function extractBtih(magnetUrl: string | undefined | null): string | null {
  if (!magnetUrl) return null
  const match = magnetUrl.match(BTIH_RE)
  return match ? match[1].toLowerCase() : null
}

/** Normalizes an info hash to lowercase for stable comparison/correlation. */
export function normalizeInfoHash(hash: string | undefined | null): string | null {
  if (!hash) return null
  const trimmed = hash.trim()
  return trimmed ? trimmed.toLowerCase() : null
}

/**
 * A torrent result is requestable if the gateway can identify it well enough for Librarr to
 * resolve at submit time: an info_hash, a BTIH extractable from a magnet, or an AudioBookBay
 * abb_url. AudioBookBay results carry NO info_hash/magnet at search time -- Librarr resolves
 * the magnet from the detail page at download time (FND-00434, WI-1496 correction #2). NZB
 * results are never requestable in this deployment: it runs Decypharr's qBittorrent facade
 * only, no SABnzbd (WI-1496 correction #3).
 */
export function isRequestable(
  result: Pick<LibrarrSearchResult, 'download_protocol' | 'info_hash' | 'magnet_url' | 'abb_url'>
): boolean {
  if (result.download_protocol === 'nzb') return false
  if (normalizeInfoHash(result.info_hash)) return true
  if (extractBtih(result.magnet_url)) return true
  if (result.abb_url) return true
  return false
}

// Placeholders a source sends in place of a size. "?" is the live-observed case: every
// AudioBookBay search row carries `size_human: "?"`. The others are defensive.
const NO_SIZE_PLACEHOLDERS = new Set(['', '?', 'unknown', 'n/a'])

/** Trims a source's human-readable size, or returns null when it carries no information. */
function normalizeSizeLabel(sizeHuman: string | undefined): string | null {
  if (sizeHuman == null) return null
  const trimmed = sizeHuman.trim()
  return NO_SIZE_PLACEHOLDERS.has(trimmed.toLowerCase()) ? null : trimmed
}

/**
 * The provider's display name. `indexer` is the provider ("AudioBookBay"); `source` is only
 * the search tab ("audiobook"), so it is the fallback -- including for a blank indexer, so
 * the label is never empty. Shared with the stored acquisition record on purpose: a queue row
 * reading "audiobook" where the search result reads "AudioBookBay" is the same bug twice.
 */
export function sourceLabelOf(raw: Pick<LibrarrSearchResult, 'indexer' | 'source'>): string {
  return raw.indexer?.trim() || raw.source
}

export function toPublicRelease(raw: LibrarrSearchResult, releaseId: string): SearchRelease {
  return {
    releaseId,
    title: raw.title,
    author: raw.author ?? '',
    narrators: [],
    format: raw.format ?? null,
    sizeBytes: raw.size ?? null,
    sizeLabel: normalizeSizeLabel(raw.size_human),
    durationSeconds: null,
    sourceLabel: sourceLabelOf(raw),
    seeders: raw.seeders ?? null,
    coverUrl: raw.cover_url ?? null,
    alreadyOwned: raw.in_library ?? false,
    existingAbsItemId: raw.library_item_id != null ? String(raw.library_item_id) : null,
    requestable: isRequestable(raw)
  }
}
