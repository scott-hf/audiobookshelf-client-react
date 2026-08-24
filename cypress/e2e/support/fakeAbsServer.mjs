#!/usr/bin/env node
// Disposable, in-memory fake Audiobookshelf backend for the acquisition web-UI Cypress e2e
// journey (WI-1496 Gate 4 / Task 6). This process is the ONLY thing the Next app's
// server-side fetches (getServerBaseUrl() -> /login, /api/authorize, /api/libraries) can
// reach in this environment -- there is no real ABS instance, no droplet, no production
// data anywhere near it. Every value below is synthetic and only exists for the lifetime of
// this process. Zero npm dependencies on purpose (Node's built-in http only) so it starts in
// milliseconds and needs no install step of its own.
import http from 'node:http'

const PORT = Number(process.env.FAKE_ABS_PORT || 3333)
const LIBRARY_ID = process.env.FAKE_ABS_LIBRARY_ID || 'lib1'
// `next dev`/`next start` unconditionally overwrite `process.env.PORT` to match their OWN
// resolved listen port (node_modules/next/dist/server/lib/start-server.js:296) -- so
// src/lib/api.ts's getServerBaseUrl() (which builds the ABS target from HOST/PORT) can never
// be pointed at a genuinely different PORT than Next's own once Next has booted. The only
// env var Next does not touch is HOST, so this fake server binds to a distinct loopback alias
// (127.0.0.2 by default -- a distinct loopback alias from Next's own 127.0.0.1/localhost bind,
// override via FAKE_ABS_HOST) while listening on THE SAME port Next ends up using -- pair with
// `HOST=<FAKE_ABS_HOST> next dev -p <FAKE_ABS_PORT>` so getServerBaseUrl() resolves to this
// process instead of recursing into Next itself (the runaway GET /status loop this comment
// sits next to fixes -- see docs/implementation-status.md Gate 4 Task 6).
const BIND_HOST = process.env.FAKE_ABS_HOST || '127.0.0.2'

const now = () => Date.now()

/** src/lib/jwt.ts's decodeJWT() requires a genuine 3-segment (header.payload.signature)
 * base64url token with a numeric `exp` claim -- it never verifies the signature (decode-only,
 * real signature verification happens server-side against the real ABS instance), but a plain
 * opaque string like 'e2e-access-token' has zero dots and decodes to null, which
 * isTokenExpired() treats as expired. Mint a JWT-shaped (but unsigned) token so
 * isSessionTokenValid() in proxy.ts / src/lib/jwt.ts accepts it. */
function fakeJwt(expiresInSeconds) {
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  const header = b64url({ alg: 'none', typ: 'JWT' })
  const payload = b64url({ exp: Math.floor(now() / 1000) + expiresInSeconds, iat: Math.floor(now() / 1000) })
  return `${header}.${payload}.e2e-fake-signature`
}

/** Minimal-but-complete ServerSettings (src/types/api.ts) -- every field the type declares
 * non-optional gets a plausible default so no client code that reads it directly (without
 * optional chaining) sees `undefined`. */
const serverSettings = {
  scannerParseSubtitle: false,
  scannerFindCovers: true,
  scannerCoverProvider: 'google',
  scannerPreferMatchedMetadata: false,
  scannerDisableWatcher: false,
  storeCoverWithItem: false,
  storeMetadataWithItem: false,
  metadataFileFormat: 'json',
  rateLimitLoginRequests: 10,
  rateLimitLoginWindow: 600000,
  allowIframe: false,
  backupPath: '/tmp/e2e-backups',
  backupSchedule: false,
  backupsToKeep: 2,
  maxBackupSize: 1,
  loggerDailyLogsToKeep: 7,
  loggerScannerLogsToKeep: 2,
  homeBookshelfView: 0,
  bookshelfView: 0,
  podcastEpisodeSchedule: '0 * * * *',
  sortingIgnorePrefix: false,
  sortingPrefixes: ['the', 'a'],
  chromecastEnabled: false,
  dateFormat: 'MM/dd/yyyy',
  timeFormat: 'HH:mm',
  language: 'en-us',
  allowedOrigins: [],
  logLevel: 1,
  version: '2.99.0-e2e-fake',
  buildNumber: '0',
  authActiveAuthMethods: ['local'],
  authOpenIDTokenSigningAlgorithm: 'RS256',
  authOpenIDButtonText: 'Login with OpenId',
  authOpenIDAutoLaunch: false,
  authOpenIDAutoRegister: false
}

function user(overrides = {}) {
  return {
    id: 'u1',
    username: 'e2e-admin',
    type: 'admin',
    token: '',
    mediaProgress: [],
    seriesHideFromContinueListening: [],
    bookmarks: [],
    isActive: true,
    isLocked: false,
    createdAt: now(),
    permissions: {
      accessAllLibraries: true,
      accessAllTags: true,
      accessExplicitContent: true,
      canDownload: true,
      canUpload: true,
      canDelete: true,
      canUpdate: true
    },
    librariesAccessible: [LIBRARY_ID],
    itemTagsSelected: [],
    ...overrides
  }
}

function loginPayload(withTokens) {
  return {
    user: withTokens ? user({ accessToken: fakeJwt(3600), refreshToken: fakeJwt(7 * 24 * 60 * 60) }) : user(),
    userDefaultLibraryId: LIBRARY_ID,
    serverSettings,
    ereaderDevices: [],
    Source: 'e2e-fake'
  }
}

const library = {
  id: LIBRARY_ID,
  name: 'E2E Test Library',
  displayOrder: 1,
  icon: 'audiobooks',
  mediaType: 'book',
  createdAt: now(),
  updatedAt: now()
}

/** Item ID the journey's fixtures (cypress/fixtures/acquisition/queue-available.json) resolve
 * the imported acquisition to -- LibraryItemClient.tsx reads `libraryItem.media.metadata`
 * directly (no optional chaining), so `GET /api/items/:id` must return a real BookMedia/
 * BookMetadata shape (src/types/api.ts), not the generic catch-all's `200 {}`. */
const LIBRARY_ITEM_ID = 'abs_e2e_item_1'
const libraryItem = {
  id: LIBRARY_ITEM_ID,
  ino: '1',
  libraryId: LIBRARY_ID,
  folderId: 'folder1',
  path: '/audiobooks/Project Hail Mary',
  relPath: 'Project Hail Mary',
  isFile: false,
  mtimeMs: now(),
  ctimeMs: now(),
  birthtimeMs: now(),
  addedAt: now(),
  updatedAt: now(),
  isMissing: false,
  isInvalid: false,
  mediaType: 'book',
  media: {
    id: 'media1',
    libraryItemId: LIBRARY_ITEM_ID,
    metadata: {
      title: 'Project Hail Mary',
      authors: [{ id: 'author1', name: 'Andy Weir' }],
      narrators: ['Ray Porter'],
      series: [],
      genres: [],
      explicit: false,
      authorName: 'Andy Weir'
    },
    tags: [],
    audioFiles: [],
    tracks: [],
    numTracks: 0,
    numAudioFiles: 0,
    numChapters: 0
  },
  numFiles: 0
}

function send(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)

  // Real /status handler (src/types/api.ts ServerStatus): an always-uninitialized fake server
  // (falling through to the generic catch-all's `200 {}`) makes `isServerInitialized` false
  // app-wide, which both derails /login (ServerInitForm instead of LoginForm) and makes
  // proxy.ts's stale-cookie-clearing branch fire on every /login hit -- reproduced as a
  // runaway retry loop of GET /status requests (see docs/implementation-status.md Task 6).
  if (req.method === 'GET' && url.pathname === '/status') {
    return send(res, 200, {
      serverVersion: '2.99.0-e2e-fake',
      language: 'en-us',
      isInit: true,
      authMethods: ['local'],
      authFormData: {},
      app: 'audiobookshelf'
    })
  }

  if (req.method === 'POST' && url.pathname === '/login') return send(res, 200, loginPayload(true))
  if (req.method === 'POST' && url.pathname === '/api/authorize') return send(res, 200, loginPayload(false))
  if (req.method === 'GET' && url.pathname === '/api/me') return send(res, 200, user())
  if (req.method === 'GET' && url.pathname === '/api/libraries') return send(res, 200, { libraries: [library] })
  if (req.method === 'GET' && url.pathname === `/api/libraries/${LIBRARY_ID}`) return send(res, 200, library)
  if (req.method === 'GET' && url.pathname === `/api/items/${LIBRARY_ITEM_ID}`) return send(res, 200, libraryItem)

  // Everything else the app might probe (filter data, socket polling, listening stats, ...)
  // degrades gracefully client-side when it 404s/empty-responds (e.g. useFilterData.ts's
  // catch path just leaves filterData null) -- logged here so a real gap is visible in this
  // process's own stdout rather than silently swallowed.
  console.log(`[fake-abs] unhandled ${req.method} ${url.pathname}`)
  if (req.method === 'GET') return send(res, 200, {})
  return send(res, 204, {})
})

server.listen(PORT, BIND_HOST, () => {
  console.log(`[fake-abs] listening on http://${BIND_HOST}:${PORT} (library ${LIBRARY_ID})`)
})
