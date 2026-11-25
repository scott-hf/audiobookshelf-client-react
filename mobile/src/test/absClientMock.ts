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
    // UserProgressProvider fetches /api/me on mount; an empty progress list keeps tests that don't
    // care about progress from needing to stub it.
    getMe: () => Promise.resolve({ id: 'user-1', username: 'tester', mediaProgress: [] }),
    ...client
  } as AbsClient
}
