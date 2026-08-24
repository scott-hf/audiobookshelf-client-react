import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assertRealPathUnder, assertUnder, bookDestination, destinationSuffix, resolveUnder, sanitizeSegment } from './safePath'

const ROOT = path.resolve(path.sep === '\\' ? 'C:\\media\\library' : '/media/library')

describe('resolveUnder', () => {
  it.each(['../escape', 'Author/../../escape', '..', 'a/../..'])('rejects %s', (candidate) => {
    expect(() => resolveUnder(ROOT, candidate)).toThrow('path_outside_root')
  })

  it('rejects absolute paths', () => {
    expect(() => resolveUnder(ROOT, path.resolve(path.sep + 'absolute'))).toThrow('path_outside_root')
  })

  it('rejects the root itself', () => {
    expect(() => resolveUnder(ROOT, '.')).toThrow('path_outside_root')
  })

  it('accepts a nested relative path', () => {
    expect(resolveUnder(ROOT, path.join('Andy Weir', 'Artemis'))).toBe(path.join(ROOT, 'Andy Weir', 'Artemis'))
  })

  it('rejects a sibling directory sharing the root prefix', () => {
    expect(() => assertUnder(ROOT, ROOT + '-other')).toThrow('path_outside_root')
  })
})

describe('sanitizeSegment', () => {
  it('turns a colon into a spaced hyphen', () => {
    expect(sanitizeSegment('Project: Hail Mary')).toBe('Project - Hail Mary')
  })

  it('replaces separators and collapses whitespace', () => {
    expect(sanitizeSegment('Andy/Weir')).toBe('Andy Weir')
    expect(sanitizeSegment('a\\b|c?d*e"f<g>h')).toBe('a b c d e f g h')
  })

  it('strips control characters', () => {
    expect(sanitizeSegment(`Ti${String.fromCharCode(7)}tle`)).toBe('Ti tle')
  })

  it('strips trailing dots and spaces', () => {
    expect(sanitizeSegment('Trailing...  ')).toBe('Trailing')
  })

  it('caps length and falls back to Unknown', () => {
    expect(sanitizeSegment('x'.repeat(500))).toHaveLength(120)
    expect(sanitizeSegment('   ')).toBe('Unknown')
    expect(sanitizeSegment('///')).toBe('Unknown')
  })
})

describe('bookDestination', () => {
  it('creates a deterministic safe author/title destination', () => {
    expect(bookDestination(ROOT, 'Andy/Weir', 'Project: Hail Mary')).toBe(path.join(ROOT, 'Andy Weir', 'Project - Hail Mary'))
  })

  it('uses Unknown for a missing author rather than flattening into the root', () => {
    expect(bookDestination(ROOT, '', 'Artemis')).toBe(path.join(ROOT, 'Unknown', 'Artemis'))
  })

  it('appends a deterministic disambiguator suffix when asked', () => {
    const suffix = destinationSuffix('acq_abcdefghijkl')
    expect(bookDestination(ROOT, 'Andy Weir', 'Artemis', suffix)).toBe(path.join(ROOT, 'Andy Weir', `Artemis [${suffix}]`))
    expect(suffix).toBe('abcdefgh')
  })

  it('cannot be driven out of the root by traversal metadata', () => {
    // sanitizeSegment neutralizes the separators before resolveUnder ever sees them, so
    // `..` survives only as inert literal text inside a single segment.
    const destination = bookDestination(ROOT, '../../etc', 'passwd')
    expect(destination.startsWith(ROOT + path.sep)).toBe(true)
    expect(destination.split(path.sep)).not.toContain('..')
    expect(destination).toBe(path.join(ROOT, '.. .. etc', 'passwd'))
  })
})

describe('assertRealPathUnder', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'safepath-'))
  })

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('accepts a non-existent leaf under an existing root', async () => {
    const root = path.join(tmp, 'root')
    await fs.mkdir(root)
    const target = path.join(root, 'Author', 'Title')
    await expect(assertRealPathUnder(root, target)).resolves.toBe(await realJoin(root, 'Author', 'Title'))
  })

  it('rejects a directory inside the root whose realpath is outside it', async () => {
    const root = path.join(tmp, 'root')
    const outside = path.join(tmp, 'outside')
    await fs.mkdir(root)
    await fs.mkdir(outside)
    const link = path.join(root, 'escape')
    try {
      await fs.symlink(outside, link, 'junction')
    } catch {
      return // unprivileged Windows host cannot create links; confinement is covered lexically above
    }
    await expect(assertRealPathUnder(root, path.join(link, 'book'))).rejects.toThrow('path_outside_root')
  })
})

async function realJoin(root: string, ...rest: string[]): Promise<string> {
  return path.resolve(await fs.realpath(root), ...rest)
}
