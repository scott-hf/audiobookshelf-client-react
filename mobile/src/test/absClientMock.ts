import type { AbsClient } from '../api/absClient'

/**
 * Fills in AbsClient methods that presentational code calls unconditionally, so tests only
 * have to stub the calls they actually assert on.
 *
 * `authorizedStreamUrl` is the case this exists for: LibraryPage/BookDetailsPage build cover
 * URLs through it on every render, and a partial mock without it throws during render rather
 * than failing an assertion (which makes the real failure hard to read).
 */
export function withClientDefaults(client: Partial<AbsClient>): AbsClient {
  return {
    authorizedStreamUrl: (contentUrl: string) => `https://books.test${contentUrl}?token=test`,
    getServerUrl: () => 'https://books.test',
    getAccessToken: () => 'test-token',
    ...client
  } as AbsClient
}
