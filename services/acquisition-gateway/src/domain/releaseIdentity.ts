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

export function toPublicRelease(raw: LibrarrSearchResult, releaseId: string): SearchRelease {
  return {
    releaseId,
    title: raw.title,
    author: raw.author ?? '',
    narrators: [],
    format: raw.format ?? 'unknown',
    sizeBytes: raw.size ?? null,
    durationSeconds: null,
    sourceLabel: raw.source,
    qualityLabel: raw.format?.toUpperCase() ?? 'Unknown',
    seeders: raw.seeders ?? null,
    coverUrl: raw.cover_url ?? null,
    alreadyOwned: raw.in_library ?? false,
    existingAbsItemId: raw.library_item_id != null ? String(raw.library_item_id) : null,
    requestable: isRequestable(raw)
  }
}
