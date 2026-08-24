import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { StagingInspector, isSupportedAudio } from './stagingInspector'

describe('StagingInspector', () => {
  let staging: string
  let clock: number

  const inspector = () => new StagingInspector({ stagingRoot: staging, stabilitySeconds: 30, now: () => clock })

  beforeEach(async () => {
    staging = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'staging-')))
    clock = 1_700_000_000_000
  })

  afterEach(async () => {
    await fs.rm(staging, { recursive: true, force: true })
  })

  async function write(relative: string, bytes: number): Promise<string> {
    const target = path.join(staging, relative)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, Buffer.alloc(bytes, 1))
    return target
  }

  it('requires a supported file and two identical observations separated by the stability window', async () => {
    await write(path.join('Andy Weir', 'Project Hail Mary', 'book.m4b'), 32)
    const candidate = path.join(staging, 'Andy Weir', 'Project Hail Mary')
    const subject = inspector()

    const first = await subject.observe(candidate)
    expect(first.stable).toBe(false)
    expect(first).toMatchObject({ totalBytes: 32, audioFileCount: 1 })

    clock += 5_000
    expect((await subject.observe(candidate)).stable).toBe(false)

    clock += 30_000
    const third = await subject.observe(candidate)
    expect(third).toMatchObject({ stable: true, totalBytes: 32, audioFileCount: 1 })
  })

  it('restarts the stability window when the tree changes', async () => {
    await write(path.join('Book', 'part1.mp3'), 16)
    const candidate = path.join(staging, 'Book')
    const subject = inspector()

    await subject.observe(candidate)
    clock += 60_000
    await write(path.join('Book', 'part2.mp3'), 16)
    const afterChange = await subject.observe(candidate)
    expect(afterChange.stable).toBe(false)
    expect(afterChange.audioFileCount).toBe(2)

    clock += 60_000
    expect((await subject.observe(candidate)).stable).toBe(true)
  })

  it('counts nested audio files and includes non-audio companions in the fingerprint', async () => {
    await write(path.join('Book', 'disc1', 'a.mp3'), 8)
    await write(path.join('Book', 'disc2', 'b.flac'), 8)
    await write(path.join('Book', 'cover.jpg'), 4)
    const observation = await inspector().observe(path.join(staging, 'Book'))
    expect(observation.audioFileCount).toBe(2)
    expect(observation.totalBytes).toBe(20)
    expect(observation.files.map((f) => f.relativePath)).toEqual(['cover.jpg', 'disc1/a.mp3', 'disc2/b.flac'])
  })

  it('normalizes a single-file Librarr path to its containing directory', async () => {
    const file = await write(path.join('Book', 'solo.m4b'), 12)
    const observation = await inspector().observe(file)
    expect(observation.root).toBe(path.join(staging, 'Book'))
    expect(observation.audioFileCount).toBe(1)
  })

  it('rejects a tree with no supported audio', async () => {
    await write(path.join('Book', 'readme.txt'), 4)
    await expect(inspector().observe(path.join(staging, 'Book'))).rejects.toThrow('staging_no_audio')
  })

  it('rejects a path outside the staging root', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'outside-'))
    try {
      await expect(inspector().observe(outside)).rejects.toThrow('path_outside_root')
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('rejects a missing tree as retryable', async () => {
    await expect(inspector().observe(path.join(staging, 'nope'))).rejects.toThrow('staging_missing')
  })

  it('rejects a symlink inside the tree', async () => {
    const target = await write(path.join('Book', 'real.m4b'), 8)
    try {
      await fs.symlink(target, path.join(staging, 'Book', 'link.m4b'), 'file')
    } catch {
      return // unprivileged Windows host cannot create symlinks
    }
    await expect(inspector().observe(path.join(staging, 'Book'))).rejects.toThrow('staging_unsupported_entry')
  })

  it('recognizes every settled supported extension and nothing else', () => {
    for (const ext of ['.m4b', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wav']) {
      expect(isSupportedAudio(`x${ext}`)).toBe(true)
      expect(isSupportedAudio(`x${ext.toUpperCase()}`)).toBe(true)
    }
    for (const ext of ['.epub', '.jpg', '.nfo', '.txt', '']) {
      expect(isSupportedAudio(`x${ext}`)).toBe(false)
    }
  })
})
