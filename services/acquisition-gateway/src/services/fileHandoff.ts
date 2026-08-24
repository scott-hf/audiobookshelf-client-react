import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { DomainError } from '../domain/errors'

export interface TreeEntry {
  relativePath: string
  sizeBytes: number
  sha256: string
}

/**
 * The filesystem surface the handoff needs, injected so tests can force EXDEV and interrupt
 * the copy at exact boundaries without a second physical filesystem.
 */
export interface FsAdapter {
  exists(target: string): Promise<boolean>
  mkdirp(target: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  /** Recursive copy that refuses symlinks and never follows them. */
  copyTree(from: string, to: string): Promise<void>
  /** Throws unless `to` contains exactly `from`'s relative paths, sizes, and content hashes. */
  verifyTree(from: string, to: string): Promise<void>
  contentFingerprint(root: string): Promise<string>
  rm(target: string): Promise<void>
}

export interface HandoffInput {
  source: string
  destination: string
  acquisitionId: string
  /** Content fingerprint persisted when the tree was declared staged. Lets a restart tell
   * "my own completed import" apart from "somebody else's directory at my destination". */
  expectedFingerprint?: string
}

export interface HandoffResult {
  destination: string
  method: 'rename' | 'copy' | 'already-complete'
}

export function temporaryPathFor(destination: string, acquisitionId: string): string {
  return path.join(path.dirname(destination), `.importing-${acquisitionId}`)
}

/**
 * Moves a validated staged tree to its final destination so that ABS can only ever observe a
 * complete book: same-filesystem uses an atomic rename; cross-filesystem copies into a hidden
 * `.importing-<acquisitionId>` sibling, verifies it byte-for-byte, then atomically renames
 * that into place. The hidden tree is never exposed to ABS and never merged into an existing
 * directory (02-SETTLED-DECISIONS.md, "Filesystem handoff").
 *
 * Idempotent by construction: every restart path re-derives its decision from what is on
 * disk, so calling `move` again after any interruption is safe.
 */
export class FileHandoff {
  constructor(private readonly fs: FsAdapter) {}

  async move(input: HandoffInput): Promise<HandoffResult> {
    const temporary = temporaryPathFor(input.destination, input.acquisitionId)

    if (await this.fs.exists(input.destination)) {
      return this.reconcileExistingDestination(input, temporary)
    }

    await this.fs.mkdirp(path.dirname(input.destination))
    // A previous attempt may have died mid-copy; the hidden tree is ours by name, so it is
    // always safe to discard rather than resume from an unknown state.
    if (await this.fs.exists(temporary)) await this.fs.rm(temporary)

    try {
      await this.fs.rename(input.source, input.destination)
      return { destination: input.destination, method: 'rename' }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    }

    try {
      await this.fs.copyTree(input.source, temporary)
      await this.fs.verifyTree(input.source, temporary)
    } catch (error) {
      await this.fs.rm(temporary).catch(() => undefined)
      throw error
    }
    await this.fs.rename(temporary, input.destination)
    await this.fs.rm(input.source)
    return { destination: input.destination, method: 'copy' }
  }

  /**
   * Something already occupies the destination. Either it is this acquisition's own finished
   * import (a restart after the final rename) or it belongs to a different book -- and the
   * two must never be conflated, because merging would corrupt an unrelated library entry.
   */
  private async reconcileExistingDestination(input: HandoffInput, temporary: string): Promise<HandoffResult> {
    const destinationFingerprint = await this.fs.contentFingerprint(input.destination)

    if (input.expectedFingerprint && destinationFingerprint === input.expectedFingerprint) {
      if (await this.fs.exists(input.source)) await this.fs.rm(input.source)
      if (await this.fs.exists(temporary)) await this.fs.rm(temporary).catch(() => undefined)
      return { destination: input.destination, method: 'already-complete' }
    }

    if (await this.fs.exists(input.source)) {
      const sourceFingerprint = await this.fs.contentFingerprint(input.source)
      if (sourceFingerprint === destinationFingerprint) {
        await this.fs.rm(input.source)
        return { destination: input.destination, method: 'already-complete' }
      }
    }

    throw new DomainError(
      'destination_conflict',
      `destination_conflict: ${input.destination} already exists and is not this acquisition`,
      false
    )
  }
}

/** Production adapter over node:fs. Refuses symlinks anywhere in the copied tree. */
export function nodeFsAdapter(): FsAdapter {
  return {
    async exists(target) {
      try {
        await fsp.lstat(target)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      }
    },
    async mkdirp(target) {
      await fsp.mkdir(target, { recursive: true })
    },
    async rename(from, to) {
      await fsp.rename(from, to)
    },
    async copyTree(from, to) {
      await copyTreeNoSymlinks(from, to)
    },
    async verifyTree(from, to) {
      const [a, b] = await Promise.all([listTree(from), listTree(to)])
      const left = JSON.stringify(a)
      const right = JSON.stringify(b)
      if (left !== right) {
        throw new DomainError('handoff_verification_failed', 'handoff_verification_failed: copied tree does not match source', true)
      }
    },
    async contentFingerprint(root) {
      return fingerprintEntries(await listTree(root))
    },
    async rm(target) {
      await fsp.rm(target, { recursive: true, force: true })
    }
  }
}

async function copyTreeNoSymlinks(from: string, to: string): Promise<void> {
  const stat = await fsp.lstat(from)
  if (stat.isSymbolicLink()) {
    throw new DomainError('staging_unsupported_entry', `staging_unsupported_entry: symlink at ${from}`, false)
  }
  if (stat.isFile()) {
    await fsp.mkdir(path.dirname(to), { recursive: true })
    await fsp.copyFile(from, to)
    // Default is preserve: Librarr writes 0644 files inside 0755 directories (FND-00413) and
    // copyFile already carries the source mode. See docs/handoff/correlation-note.md s.4.
    return
  }
  if (!stat.isDirectory()) {
    throw new DomainError('staging_unsupported_entry', `staging_unsupported_entry: non-regular file at ${from}`, false)
  }
  await fsp.mkdir(to, { recursive: true, mode: stat.mode })
  for (const entry of await fsp.readdir(from)) {
    await copyTreeNoSymlinks(path.join(from, entry), path.join(to, entry))
  }
}

async function listTree(root: string): Promise<TreeEntry[]> {
  const rootStat = await fsp.lstat(root)
  const entries: TreeEntry[] = []
  if (rootStat.isFile()) {
    entries.push({ relativePath: path.basename(root), sizeBytes: rootStat.size, sha256: await hashFile(root) })
    return entries
  }
  await walk(root, '')
  entries.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0))
  return entries

  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name)
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) {
        throw new DomainError('staging_unsupported_entry', `staging_unsupported_entry: symlink at ${relative}`, false)
      }
      if (entry.isDirectory()) {
        await walk(absolute, relative)
        continue
      }
      const stat = await fsp.lstat(absolute)
      entries.push({ relativePath: relative, sizeBytes: stat.size, sha256: await hashFile(absolute) })
    }
  }
}

export function fingerprintEntries(entries: TreeEntry[]): string {
  const hash = createHash('sha256')
  for (const entry of entries) hash.update(`${entry.relativePath} ${entry.sizeBytes} ${entry.sha256}\n`)
  return hash.digest('hex')
}

async function hashFile(target: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    createReadStream(target)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', resolve)
  })
  return hash.digest('hex')
}
