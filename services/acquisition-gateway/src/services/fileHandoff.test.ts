import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { FileHandoff, nodeFsAdapter, temporaryPathFor, type FsAdapter } from './fileHandoff'

function exdev(): NodeJS.ErrnoException {
  return Object.assign(new Error('cross device'), { code: 'EXDEV' })
}

describe('FileHandoff (mocked adapter)', () => {
  let adapter: { [K in keyof FsAdapter]: ReturnType<typeof vi.fn> }
  const source = path.join('/staging', 'Book')
  const destination = path.join('/library', 'Andy Weir', 'Artemis')

  beforeEach(() => {
    adapter = {
      exists: vi.fn().mockResolvedValue(false),
      mkdirp: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockResolvedValue(undefined),
      copyTree: vi.fn().mockResolvedValue(undefined),
      verifyTree: vi.fn().mockResolvedValue(undefined),
      contentFingerprint: vi.fn().mockResolvedValue('fp'),
      rm: vi.fn().mockResolvedValue(undefined)
    }
  })

  const subject = () => new FileHandoff(adapter as unknown as FsAdapter)

  it('uses an atomic rename on the same filesystem', async () => {
    const result = await subject().move({ source, destination, acquisitionId: 'a1' })
    expect(result).toEqual({ destination, method: 'rename' })
    expect(adapter.rename).toHaveBeenCalledWith(source, destination)
    expect(adapter.copyTree).not.toHaveBeenCalled()
  })

  it('copies to a hidden temp tree on EXDEV and exposes only the final rename', async () => {
    adapter.rename.mockRejectedValueOnce(exdev())
    await subject().move({ source, destination, acquisitionId: 'a1' })

    const temporary = temporaryPathFor(destination, 'a1')
    expect(temporary.endsWith('.importing-a1')).toBe(true)
    expect(adapter.copyTree).toHaveBeenCalledWith(source, temporary)
    expect(adapter.verifyTree).toHaveBeenCalledWith(source, temporary)
    expect(adapter.rename).toHaveBeenLastCalledWith(temporary, destination)
    expect(adapter.rm).toHaveBeenCalledWith(source)
  })

  it('discards a leftover hidden tree from an interrupted copy before retrying', async () => {
    adapter.exists.mockImplementation(async (target: string) => target === temporaryPathFor(destination, 'a1'))
    adapter.rename.mockRejectedValueOnce(exdev())
    await subject().move({ source, destination, acquisitionId: 'a1' })
    expect(adapter.rm).toHaveBeenNthCalledWith(1, temporaryPathFor(destination, 'a1'))
  })

  it('cleans up the hidden tree and rethrows when verification fails', async () => {
    adapter.rename.mockRejectedValueOnce(exdev())
    adapter.verifyTree.mockRejectedValueOnce(new Error('handoff_verification_failed'))
    await expect(subject().move({ source, destination, acquisitionId: 'a1' })).rejects.toThrow('handoff_verification_failed')
    expect(adapter.rm).toHaveBeenCalledWith(temporaryPathFor(destination, 'a1'))
    expect(adapter.rename).toHaveBeenCalledTimes(1) // never renamed a bad tree into place
  })

  it('treats a restart after the final rename as already complete', async () => {
    adapter.exists.mockImplementation(async (target: string) => target === destination)
    adapter.contentFingerprint.mockResolvedValue('fp-expected')
    const result = await subject().move({ source, destination, acquisitionId: 'a1', expectedFingerprint: 'fp-expected' })
    expect(result.method).toBe('already-complete')
    expect(adapter.rename).not.toHaveBeenCalled()
  })

  it('removes a still-present source when the destination already matches it', async () => {
    adapter.exists.mockResolvedValue(true)
    adapter.contentFingerprint.mockResolvedValue('same')
    const result = await subject().move({ source, destination, acquisitionId: 'a1' })
    expect(result.method).toBe('already-complete')
    expect(adapter.rm).toHaveBeenCalledWith(source)
  })

  it('never merges into a pre-existing unrelated directory', async () => {
    adapter.exists.mockImplementation(async (target: string) => target === destination || target === source)
    adapter.contentFingerprint.mockImplementation(async (target: string) => (target === destination ? 'theirs' : 'ours'))
    await expect(
      subject().move({ source, destination, acquisitionId: 'a1', expectedFingerprint: 'ours' })
    ).rejects.toThrow('destination_conflict')
    expect(adapter.rename).not.toHaveBeenCalled()
    expect(adapter.rm).not.toHaveBeenCalled()
  })

  it('propagates a non-EXDEV rename failure without copying', async () => {
    adapter.rename.mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
    await expect(subject().move({ source, destination, acquisitionId: 'a1' })).rejects.toThrow('permission denied')
    expect(adapter.copyTree).not.toHaveBeenCalled()
  })
})

describe('nodeFsAdapter (real filesystem)', () => {
  let tmp: string
  let staging: string
  let library: string

  beforeEach(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'handoff-')))
    staging = path.join(tmp, 'staging')
    library = path.join(tmp, 'library')
    await fs.mkdir(staging, { recursive: true })
    await fs.mkdir(library, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  async function seed(root: string): Promise<void> {
    await fs.mkdir(path.join(root, 'disc1'), { recursive: true })
    await fs.writeFile(path.join(root, 'disc1', 'a.mp3'), Buffer.alloc(64, 7))
    await fs.writeFile(path.join(root, 'cover.jpg'), Buffer.alloc(16, 3))
  }

  it('renames a real tree into place and leaves nothing behind in staging', async () => {
    const source = path.join(staging, 'Book')
    await seed(source)
    const destination = path.join(library, 'Andy Weir', 'Artemis')
    const result = await new FileHandoff(nodeFsAdapter()).move({ source, destination, acquisitionId: 'a1' })
    expect(result.method).toBe('rename')
    expect(await fs.readdir(path.join(destination, 'disc1'))).toEqual(['a.mp3'])
    await expect(fs.stat(source)).rejects.toThrow()
  })

  it('verifies a copied tree and detects a byte mismatch', async () => {
    const adapter = nodeFsAdapter()
    const a = path.join(staging, 'a')
    const b = path.join(staging, 'b')
    await seed(a)
    await adapter.copyTree(a, b)
    await expect(adapter.verifyTree(a, b)).resolves.toBeUndefined()
    expect(await adapter.contentFingerprint(a)).toBe(await adapter.contentFingerprint(b))

    await fs.writeFile(path.join(b, 'disc1', 'a.mp3'), Buffer.alloc(64, 9))
    await expect(adapter.verifyTree(a, b)).rejects.toThrow('handoff_verification_failed')
  })

  it('completes the copy path end to end when rename reports EXDEV', async () => {
    const real = nodeFsAdapter()
    const source = path.join(staging, 'Book')
    await seed(source)
    const destination = path.join(library, 'Andy Weir', 'Artemis')
    let renames = 0
    const adapter: FsAdapter = {
      ...real,
      rename: async (from, to) => {
        if (renames++ === 0) throw exdev()
        await real.rename(from, to)
      }
    }
    const result = await new FileHandoff(adapter).move({ source, destination, acquisitionId: 'a1' })
    expect(result.method).toBe('copy')
    expect(await fs.readFile(path.join(destination, 'disc1', 'a.mp3'))).toEqual(Buffer.alloc(64, 7))
    await expect(fs.stat(source)).rejects.toThrow()
    await expect(fs.stat(temporaryPathFor(destination, 'a1'))).rejects.toThrow()
  })
})
