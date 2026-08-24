import { extractBtih, normalizeInfoHash } from './releaseIdentity'
import type { LibrarrSearchResult, LibrarrSubmitResponse } from '../adapters/librarrSchemas'

/**
 * Tracking-key precedence (WI-1496 correction #3): submit-response `hash` > `job_id` >
 * `nzo_id` > search-result `info_hash`. Title matching is NEVER used for correlation -- an
 * acceptance the gateway cannot key returns null so the caller routes it to needs_attention
 * instead of guessing at a match during reconciliation.
 */
export function trackingKey(result: LibrarrSearchResult, submit: LibrarrSubmitResponse): string | null {
  const submitHash = normalizeInfoHash(submit.hash)
  if (submitHash) return `torrent:${submitHash}`
  if (submit.job_id) return `job:${submit.job_id}`
  if (submit.nzo_id) return `nzb:${submit.nzo_id}`
  const hash = normalizeInfoHash(result.info_hash) ?? extractBtih(result.magnet_url)
  if (hash) return `torrent:${hash}`
  return null
}

export function trackingKeyKind(key: string): string {
  return key.split(':', 1)[0]
}

export function trackingKeyValue(key: string): string {
  return key.slice(key.indexOf(':') + 1)
}
