#!/usr/bin/env node
// Disposable, in-memory fake Audiobookshelf + acquisition-gateway backend for ShelfDroid's
// Playwright vertical-slice journey. Zero npm dependencies (Node's built-in http only), same
// spirit as cypress/e2e/support/fakeAbsServer.mjs but far simpler: ShelfDroid is a pure
// bearer-token client (mobile/src/auth/session.ts), so there's no JWT-shaping, no cookies, no
// server-init/status probing to satisfy -- just the exact endpoints
// mobile/src/api/absClient.ts and mobile/src/api/acquisitionClient.ts call.
import http from 'node:http'

const PORT = Number(process.env.FAKE_ABS_PORT || 4545)
const LIBRARY_ID = process.env.FAKE_ABS_LIBRARY_ID || 'lib1'
const ITEM_ID = 'abs_e2e_item_1'
const ACCESS_TOKEN = 'e2e-access-token'
const REFRESH_TOKEN = 'e2e-refresh-token'

function send(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

/** One second of 16-bit mono silence at 8kHz -- small, valid, and enough for a headless
 * <audio> element to reach readyState >= HAVE_CURRENT_DATA and resolve play(). */
function silentWav() {
  const sampleRate = 8000
  const numSamples = sampleRate
  const dataSize = numSamples * 2
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)
  return buffer
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => resolve(data ? JSON.parse(data) : {}))
  })
}

const libraryItem = {
  id: ITEM_ID,
  libraryId: LIBRARY_ID,
  media: {
    metadata: { title: 'Project Hail Mary', authorName: 'Andy Weir', description: 'A lone astronaut.' },
    duration: 3600
  },
  userMediaProgress: null
}

let acquisitions = []
let acquisitionSeq = 0

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const auth = req.headers.authorization

  // The mobile app is served from a different origin (Vite's dev port) and calls this fake
  // server directly by absolute URL, exactly like the packaged app calls a real ABS server --
  // so, unlike the same-origin web app's Next.js proxy, every response needs real CORS headers
  // or the browser drops it client-side before ShelfDroid ever sees a status code.
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('access-control-allow-headers', 'authorization, content-type, x-return-tokens, x-refresh-token')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    return res.end()
  }

  // --- ABS auth ---
  if (req.method === 'POST' && url.pathname === '/login') {
    return send(res, 200, { user: { id: 'u1', accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN } })
  }
  if (req.method === 'POST' && url.pathname === '/auth/refresh') {
    return send(res, 200, { user: { accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN } })
  }

  // The <audio> element loads this directly (absClient.authorizedStreamUrl appends the token
  // as a query param, not a header, since <audio src> cannot carry an Authorization header).
  // A tiny valid silent WAV so a headless browser's audio.play() actually resolves instead of
  // rejecting on a 404/empty body.
  if (req.method === 'GET' && url.pathname === `/api/items/${ITEM_ID}/file/f1`) {
    if (url.searchParams.get('token') !== ACCESS_TOKEN) return send(res, 401, { message: 'Unauthorized' })
    const wav = silentWav()
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wav.length })
    return res.end(wav)
  }

  if (auth !== `Bearer ${ACCESS_TOKEN}`) {
    return send(res, 401, { message: 'Unauthorized' })
  }

  // --- ABS browse/stream ---
  if (req.method === 'GET' && url.pathname === '/api/libraries') {
    return send(res, 200, { libraries: [{ id: LIBRARY_ID, name: 'E2E Library', mediaType: 'book' }] })
  }
  if (req.method === 'GET' && url.pathname === `/api/libraries/${LIBRARY_ID}/items`) {
    return send(res, 200, { results: [libraryItem], total: 1 })
  }
  if (req.method === 'GET' && url.pathname === `/api/items/${ITEM_ID}`) {
    return send(res, 200, libraryItem)
  }
  if (req.method === 'POST' && url.pathname === `/api/items/${ITEM_ID}/play`) {
    return send(res, 200, { id: 'session1', currentTime: 0, audioTracks: [{ index: 0, contentUrl: `/api/items/${ITEM_ID}/file/f1`, duration: 3600 }] })
  }
  if (req.method === 'POST' && url.pathname === '/api/session/session1/sync') return send(res, 200, {})
  if (req.method === 'POST' && url.pathname === '/api/session/session1/close') return send(res, 200, {})

  // --- Acquisition gateway ---
  if (req.method === 'GET' && url.pathname === '/acquisition-api/v1/status') {
    return send(res, 200, { version: 'e2e', ready: true, librarr: { reachable: true }, staging: { ready: true }, libraries: [{ id: LIBRARY_ID, enabled: true }] })
  }
  if (req.method === 'GET' && url.pathname === '/acquisition-api/v1/search/audiobooks') {
    return send(res, 200, {
      searchSessionId: 'search-e2e-1',
      results: [
        {
          releaseId: 'rel-e2e-1',
          title: 'Project Hail Mary',
          author: 'Andy Weir',
          narrators: ['Ray Porter'],
          format: 'm4b',
          sizeBytes: 512_000_000,
          durationSeconds: 3600,
          sourceLabel: 'AudioBookBay',
          qualityLabel: 'V0',
          seeders: 12,
          coverUrl: null,
          alreadyOwned: false,
          existingAbsItemId: null,
          requestable: true
        }
      ]
    })
  }
  if (req.method === 'POST' && url.pathname === '/acquisition-api/v1/acquisitions') {
    const body = await readBody(req)
    acquisitionSeq += 1
    const acquisition = {
      id: `acq-e2e-${acquisitionSeq}`,
      libraryId: LIBRARY_ID,
      title: 'Project Hail Mary',
      author: 'Andy Weir',
      state: 'queued',
      progressPercent: null,
      absItemId: null,
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      idempotencyKey: body.idempotencyKey
    }
    acquisitions = [acquisition, ...acquisitions]
    return send(res, 201, acquisition)
  }
  if (req.method === 'GET' && url.pathname === '/acquisition-api/v1/acquisitions') {
    return send(res, 200, acquisitions)
  }
  const retryMatch = url.pathname.match(/^\/acquisition-api\/v1\/acquisitions\/(.+)\/retry$/)
  if (req.method === 'POST' && retryMatch) {
    const acquisition = acquisitions.find((a) => a.id === retryMatch[1])
    if (acquisition) acquisition.state = 'submitted'
    return send(res, 200, acquisition)
  }
  const cancelMatch = url.pathname.match(/^\/acquisition-api\/v1\/acquisitions\/(.+)$/)
  if (req.method === 'DELETE' && cancelMatch) {
    const acquisition = acquisitions.find((a) => a.id === cancelMatch[1])
    if (acquisition) acquisition.state = 'cancelled'
    return send(res, 200, acquisition)
  }

  console.log(`[fake-abs] unhandled ${req.method} ${url.pathname}`)
  return send(res, 404, { code: 'not_found', message: 'unhandled fake route' })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[fake-abs] listening on http://127.0.0.1:${PORT} (library ${LIBRARY_ID})`)
})
