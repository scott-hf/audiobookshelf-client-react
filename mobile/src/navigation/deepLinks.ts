/** Deep-link route validation -- WI-1496 t900 Task 4.
 *
 * Maps an incoming Android deep link (verified `https://<HTTPS_HOST>/...` App Link, or the
 * custom `shelfdroid://` scheme) to an in-app route path. Every accepted shape is enumerated
 * explicitly -- this is a security-relevant allow-list, not a generic path passthrough, so an
 * unexpected host, scheme, or path shape (including traversal segments) is rejected by simply
 * not matching any known pattern rather than being sanitized and routed anyway. Never loosen
 * this to a catch-all for convenience.
 */

/** Placeholder verified-links host -- matches deploy/acquisition/assetlinks.json.example and the
 * AndroidManifest.xml intent-filter. Not a real production hostname. */
const HTTPS_HOST = 'books.example.com'
const CUSTOM_SCHEME = 'shelfdroid'

const ID_SEGMENT = /^[A-Za-z0-9_-]+$/

function isValidId(segment: string | undefined): segment is string {
  return typeof segment === 'string' && ID_SEGMENT.test(segment)
}

/** Returns the app-internal route path for a deep link, or null if the link does not match a
 * known, safe shape (wrong host, wrong scheme, wrong path shape, or an invalid/traversal id
 * segment). */
export function routeFromDeepLink(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  let segments: string[]
  if (parsed.protocol === 'https:') {
    if (parsed.hostname !== HTTPS_HOST) return null
    segments = parsed.pathname.split('/').filter(Boolean)
  } else if (parsed.protocol === `${CUSTOM_SCHEME}:`) {
    // WHATWG URL parsing treats the segment right after `scheme://` as the "host" for a
    // non-special scheme with an authority (e.g. `shelfdroid://library/lib1/discover` parses
    // to hostname="library", pathname="/lib1/discover") -- recombine so custom-scheme links use
    // the same segment shape as the https path below.
    segments = [parsed.hostname, ...parsed.pathname.split('/').filter(Boolean)]
  } else {
    return null
  }

  if (segments[0] !== 'library' || !isValidId(segments[1])) return null
  const libraryId = segments[1]

  if (segments.length === 3 && segments[2] === 'discover') {
    return `/library/${libraryId}/discover`
  }

  if (segments.length === 4 && segments[2] === 'item' && isValidId(segments[3])) {
    return `/library/${libraryId}/item/${segments[3]}`
  }

  return null
}
