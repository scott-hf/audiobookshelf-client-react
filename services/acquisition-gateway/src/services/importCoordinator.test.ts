import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { openDatabase } from '../db/database'
import { AcquisitionRepository, type AcquisitionRecord } from '../db/acquisitionRepository'
import { SearchRepository } from '../db/searchRepository'
import { FileHandoff, nodeFsAdapter, temporaryPathFor } from './fileHandoff'
import { ImportCoordinator } from './importCoordinator'
import { StagingInspector } from './stagingInspector'

const HASH = 'aabbccddeeff00112233445566778899aabbccdd'
const LIBRARY_ID = 'lib-test'

describe('ImportCoordinator', () => {
  let tmp: string
  let staging: string
  let library: string
  let db: Database.Database
  let repo: AcquisitionRepository
  let clock: number
  let events: string[]

  let librarr: { getAllLibraryAudiobooks: ReturnType<typeof vi.fn>; deleteLibraryAudiobook: ReturnType<typeof vi.fn> }
  let abs: { scanLibrary: ReturnType<typeof vi.fn>; listAllLibraryItems: ReturnType<typeof vi.fn> }

  beforeEach(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'coord-')))
    staging = path.join(tmp, 'staging')
    library = path.join(tmp, 'library')
    await fs.mkdir(staging, { recursive: true })
    await fs.mkdir(library, { recursive: true })

    db = openDatabase(path.join(tmp, 'acq.sqlite'))
    repo = new AcquisitionRepository(db)
    new SearchRepository(db).create({
      id: 'search_session_1',
      absUserId: 'u1',
      absLibraryId: LIBRARY_ID,
      query: 'hail mary',
      resultsJson: '[]',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      createdAt: new Date().toISOString()
    })

    clock = 1_700_000_000_000
    events = []
    librarr = { getAllLibraryAudiobooks: vi.fn().mockResolvedValue([]), deleteLibraryAudiobook: vi.fn().mockResolvedValue(true) }
    abs = { scanLibrary: vi.fn().mockResolvedValue(undefined), listAllLibraryItems: vi.fn().mockResolvedValue([]) }
  })

  afterEach(async () => {
    db.close()
    await fs.rm(tmp, { recursive: true, force: true })
  })

  // --- helpers -------------------------------------------------------------------------

  function coordinator(overrides: { cleanupEnabled?: boolean } = {}): ImportCoordinator {
    const adapter = nodeFsAdapter()
    return new ImportCoordinator({
      repo,
      librarr,
      abs,
      inspector: new StagingInspector({ stagingRoot: staging, stabilitySeconds: 0, now: () => clock }),
      handoff: new FileHandoff(adapter),
      fs: adapter,
      libraries: new Map([[LIBRARY_ID, library]]),
      stallTimeoutSeconds: 600,
      cleanupEnabled: overrides.cleanupEnabled,
      now: () => clock,
      onEvent: (id) => events.push(id)
    })
  }

  function seedRecord(overrides: Partial<AcquisitionRecord> = {}): AcquisitionRecord {
    const nowIso = new Date(clock).toISOString()
    const record: AcquisitionRecord = {
      id: 'acq_a1',
      absUserId: 'u1',
      absLibraryId: LIBRARY_ID,
      idempotencyKey: '11111111-1111-1111-1111-111111111111',
      searchSessionId: 'search_session_1',
      releaseId: 'release_1',
      trackingKey: `torrent:${HASH}`,
      title: 'Project Hail Mary',
      author: 'Andy Weir',
      state: 'processing',
      lastSuccessfulStage: 'processing',
      createdAt: nowIso,
      updatedAt: nowIso,
      ...overrides
    }
    repo.create(record)
    return record
  }

  /** Librarr's ACTUAL staging layout: segments come from a positional split of the release
   * name, so this deliberately looks like `<Title>/<Author>` (FND-00411) -- the coordinator
   * must not care, because it reads the path from Librarr's own DB row. */
  async function seedStagedTree(relative = path.join('Project Hail Mary', 'Andy Weir')): Promise<string> {
    const root = path.join(staging, relative)
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(path.join(root, 'book.m4b'), Buffer.alloc(64, 5))
    librarr.getAllLibraryAudiobooks.mockResolvedValue([
      { id: 77, title: 'Project Hail Mary', author: 'Andy Weir', file_path: root, source_id: HASH.toUpperCase(), media_type: 'audiobook' }
    ])
    return root
  }

  const finalPath = () => path.join(library, 'Andy Weir', 'Project Hail Mary')

  function absItem(overrides: Record<string, unknown> = {}) {
    return {
      id: 'li_1',
      libraryId: LIBRARY_ID,
      path: finalPath(),
      addedAt: clock + 1_000,
      media: { metadata: { title: 'Project Hail Mary', authorName: 'Andy Weir' } },
      ...overrides
    }
  }

  // --- happy path ----------------------------------------------------------------------

  it('drives processing -> staged -> importing -> scanning -> available in one pass', async () => {
    await seedStagedTree()
    abs.listAllLibraryItems.mockResolvedValue([absItem()])

    const result = await coordinator().advance(seedRecord())

    expect(result.state).toBe('available')
    expect(result.absItemId).toBe('li_1')
    expect(result.finalPath).toBe(finalPath())
    expect(result.completedAt).toBeTruthy()
    expect(abs.scanLibrary).toHaveBeenCalledWith(LIBRARY_ID)
    expect(await fs.readFile(path.join(finalPath(), 'book.m4b'))).toEqual(Buffer.alloc(64, 5))
    // one user-scoped event per persisted transition: staged, importing, scanning, available
    expect(events.filter((id) => id === 'acq_a1')).toHaveLength(4)
  })

  it('correlates by Librarr source_id, not by path shape', async () => {
    // A staged tree whose segments are transposed relative to the book's real author/title.
    const root = await seedStagedTree(path.join('Project Hail Mary', 'Andy Weir'))
    abs.listAllLibraryItems.mockResolvedValue([absItem()])

    const result = await coordinator().advance(seedRecord())
    expect(result.stagingPath).toBe(root)
    // ...and the FINAL tree is still gateway-owned sanitized Author/Title.
    expect(result.finalPath).toBe(finalPath())
  })

  it('parks in processing while Librarr has not registered the download yet', async () => {
    librarr.getAllLibraryAudiobooks.mockResolvedValue([])
    const result = await coordinator().advance(seedRecord())
    expect(result.state).toBe('processing')
    expect(result.stalledSince).toBeTruthy()
    expect(abs.scanLibrary).not.toHaveBeenCalled()
  })

  it('gives up to needs_attention once the staging stall budget is exhausted', async () => {
    const subject = coordinator()
    const record = seedRecord()
    await subject.advance(record)
    clock += 601_000
    const result = await subject.advance(repo.findById('acq_a1')!)
    expect(result.state).toBe('needs_attention')
    expect(result.errorCode).toBe('staging_not_found')
  })

  it('waits for a stable tree instead of importing a partial one', async () => {
    const root = await seedStagedTree()
    const adapter = nodeFsAdapter()
    const subject = new ImportCoordinator({
      repo,
      librarr,
      abs,
      inspector: new StagingInspector({ stagingRoot: staging, stabilitySeconds: 30, now: () => clock }),
      handoff: new FileHandoff(adapter),
      fs: adapter,
      libraries: new Map([[LIBRARY_ID, library]]),
      stallTimeoutSeconds: 600,
      now: () => clock
    })

    expect((await subject.advance(seedRecord())).state).toBe('processing')
    await fs.writeFile(path.join(root, 'book2.m4b'), Buffer.alloc(8, 1))
    clock += 31_000
    expect((await subject.advance(repo.findById('acq_a1')!)).state).toBe('processing')

    abs.listAllLibraryItems.mockResolvedValue([absItem()])
    clock += 31_000
    expect((await subject.advance(repo.findById('acq_a1')!)).state).toBe('available')
  })

  // --- restart safety ------------------------------------------------------------------

  it('persists every boundary and never redownloads after scan failure', async () => {
    await seedStagedTree()
    abs.scanLibrary.mockRejectedValueOnce(Object.assign(new Error('abs down'), { code: 'abs_unreachable' }))

    const subject = coordinator()
    const failed = await subject.advance(seedRecord())
    expect(failed.state).toBe('failed')
    expect(failed.errorRetryable).toBe(true)
    expect(failed.lastSuccessfulStage).toBe('scanning')
    // The book is already safely in the library -- the failure cost a scan, not a download.
    expect(await fs.readFile(path.join(finalPath(), 'book.m4b'))).toEqual(Buffer.alloc(64, 5))

    abs.scanLibrary.mockResolvedValueOnce(undefined)
    abs.listAllLibraryItems.mockResolvedValue([absItem()])
    const retried = await subject.retry(repo.findById('acq_a1')!)
    expect(retried).toMatchObject({ state: 'available', absItemId: 'li_1' })
  })

  it('resumes an interrupted copy without exposing a partial book', async () => {
    const root = await seedStagedTree()
    const real = nodeFsAdapter()
    let renames = 0
    const flaky = {
      ...real,
      rename: async (from: string, to: string) => {
        renames += 1
        if (renames === 1) throw Object.assign(new Error('cross device'), { code: 'EXDEV' })
        if (renames === 2) throw new Error('crash before the final rename')
        await real.rename(from, to)
      }
    }
    const subject = new ImportCoordinator({
      repo,
      librarr,
      abs,
      inspector: new StagingInspector({ stagingRoot: staging, stabilitySeconds: 0, now: () => clock }),
      handoff: new FileHandoff(flaky),
      fs: real,
      libraries: new Map([[LIBRARY_ID, library]]),
      stallTimeoutSeconds: 600,
      now: () => clock
    })

    const interrupted = await subject.advance(seedRecord())
    expect(interrupted.state).toBe('failed')
    expect(interrupted.lastSuccessfulStage).toBe('importing')
    // The destination never existed, so ABS could never have seen a partial book.
    await expect(fs.stat(finalPath())).rejects.toThrow()
    expect(abs.scanLibrary).not.toHaveBeenCalled()
    expect(await fs.readdir(root)).toContain('book.m4b')

    abs.listAllLibraryItems.mockResolvedValue([absItem()])
    const resumed = await subject.retry(repo.findById('acq_a1')!)
    expect(resumed.state).toBe('available')
    expect(await fs.readFile(path.join(finalPath(), 'book.m4b'))).toEqual(Buffer.alloc(64, 5))
    await expect(fs.stat(temporaryPathFor(finalPath(), 'acq_a1'))).rejects.toThrow()
  })

  it('treats a restart after the final rename as complete rather than re-importing', async () => {
    await seedStagedTree()
    abs.listAllLibraryItems.mockResolvedValue([absItem()])
    const subject = coordinator()
    await subject.advance(seedRecord())

    // Simulate a crash right after the rename: rewind the row to `importing`.
    repo.update('acq_a1', { state: 'importing', absItemId: null, completedAt: null })
    const recovered = await subject.advance(repo.findById('acq_a1')!)
    expect(recovered.state).toBe('available')
    expect(await fs.readFile(path.join(finalPath(), 'book.m4b'))).toEqual(Buffer.alloc(64, 5))
  })

  // --- refusals ------------------------------------------------------------------------

  it('never merges into an unrelated directory already at the destination', async () => {
    await seedStagedTree()
    await fs.mkdir(finalPath(), { recursive: true })
    await fs.writeFile(path.join(finalPath(), 'someone-elses.m4b'), Buffer.alloc(4, 9))
    abs.listAllLibraryItems.mockResolvedValue([absItem({ path: `${finalPath()} [a1]` })])

    const result = await coordinator().advance(seedRecord())
    // The occupied destination forces the deterministic suffix rather than a merge.
    expect(result.finalPath).toBe(`${finalPath()} [a1]`)
    expect(await fs.readdir(finalPath())).toEqual(['someone-elses.m4b'])
  })

  it('routes an ambiguous ABS match to needs_attention and never guesses', async () => {
    await seedStagedTree()
    abs.listAllLibraryItems.mockResolvedValue([
      absItem({ id: 'a', path: '/elsewhere/a' }),
      absItem({ id: 'b', path: '/elsewhere/b' })
    ])
    const result = await coordinator().advance(seedRecord())
    expect(result).toMatchObject({ state: 'needs_attention', errorCode: 'ambiguous_import', errorRetryable: false })
    expect(result.absItemId).toBeFalsy()
  })

  it('waits in scanning while ABS has not indexed the book yet, then gives up boundedly', async () => {
    await seedStagedTree()
    abs.listAllLibraryItems.mockResolvedValue([])
    const subject = coordinator()

    // ABS scanning is asynchronous, so an empty first poll is a wait, not a failure.
    const waiting = await subject.advance(seedRecord())
    expect(waiting.state).toBe('scanning')
    expect(waiting.stalledSince).toBeTruthy()
    expect(abs.scanLibrary).toHaveBeenCalledTimes(1)

    // Polling again does not re-scan; it just re-checks.
    await subject.advance(repo.findById('acq_a1')!)
    expect(abs.scanLibrary).toHaveBeenCalledTimes(1)

    clock += 601_000
    const givenUp = await subject.advance(repo.findById('acq_a1')!)
    expect(givenUp).toMatchObject({ state: 'needs_attention', errorCode: 'import_not_resolved', errorRetryable: true })
  })

  it('re-scans on retry without redoing the handoff', async () => {
    await seedStagedTree()
    abs.listAllLibraryItems.mockResolvedValue([])
    const subject = coordinator()
    await subject.advance(seedRecord())
    clock += 601_000
    const givenUp = await subject.advance(repo.findById('acq_a1')!)
    expect(givenUp.state).toBe('needs_attention')

    abs.listAllLibraryItems.mockResolvedValue([absItem()])
    const retried = await subject.retry(repo.findById('acq_a1')!)
    expect(retried.state).toBe('available')
    // The scan ran again (that is what was retried) but the file was never moved twice: the
    // staged tree is long gone and the book is still intact at its destination.
    expect(abs.scanLibrary).toHaveBeenCalledTimes(2)
    expect(await fs.readFile(path.join(finalPath(), 'book.m4b'))).toEqual(Buffer.alloc(64, 5))
  })

  it('refuses a library with no configured final root', async () => {
    const root = await seedStagedTree()
    seedRecord({ state: 'staged', lastSuccessfulStage: 'staged', stagingPath: root })
    const orphan = new ImportCoordinator({
      repo,
      librarr,
      abs,
      inspector: new StagingInspector({ stagingRoot: staging, stabilitySeconds: 0, now: () => clock }),
      handoff: new FileHandoff(nodeFsAdapter()),
      fs: nodeFsAdapter(),
      libraries: new Map(),
      stallTimeoutSeconds: 600,
      now: () => clock
    })
    const failed = await orphan.advance(repo.findById('acq_a1')!)
    expect(failed).toMatchObject({ state: 'needs_attention', errorCode: 'library_not_mapped' })
  })

  it('never calls a Librarr download endpoint from any import stage', async () => {
    await seedStagedTree()
    abs.listAllLibraryItems.mockResolvedValue([absItem()])
    await coordinator().advance(seedRecord())
    expect(Object.keys(librarr)).toEqual(['getAllLibraryAudiobooks', 'deleteLibraryAudiobook'])
  })

  // --- cleanup -------------------------------------------------------------------------

  it('deletes the staged tree and the stale Librarr row after a confirmed import', async () => {
    const root = await seedStagedTree()
    abs.listAllLibraryItems.mockResolvedValue([absItem()])
    const result = await coordinator().advance(seedRecord())

    expect(result.state).toBe('available')
    await expect(fs.stat(root)).rejects.toThrow()
    expect(librarr.deleteLibraryAudiobook).toHaveBeenCalledWith('77')
    expect(repo.findById('acq_a1')!.librarrLibraryItemId).toBeNull()
  })

  it('keeps the import available when cleanup fails', async () => {
    await seedStagedTree()
    abs.listAllLibraryItems.mockResolvedValue([absItem()])
    librarr.deleteLibraryAudiobook.mockRejectedValue(new Error('librarr down'))

    const result = await coordinator().advance(seedRecord())
    expect(result.state).toBe('available')
    expect(repo.findById('acq_a1')!.state).toBe('available')
    expect(repo.findById('acq_a1')!.librarrLibraryItemId).toBe('77')
  })

  it('skips cleanup when it is disabled', async () => {
    const root = await seedStagedTree()
    abs.listAllLibraryItems.mockResolvedValue([absItem()])
    await coordinator({ cleanupEnabled: false }).advance(seedRecord())
    expect(librarr.deleteLibraryAudiobook).not.toHaveBeenCalled()
    // the tree was moved by the handoff, so the staging path is gone either way
    await expect(fs.stat(root)).rejects.toThrow()
  })
})
