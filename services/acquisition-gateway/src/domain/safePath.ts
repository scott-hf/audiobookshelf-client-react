import path from 'node:path'
import fs from 'node:fs/promises'
import { DomainError } from './errors'

/**
 * Resolves `relative` under `root` and refuses anything that escapes, is absolute, or
 * resolves to `root` itself. Purely lexical -- see `assertRealPathUnder` for the
 * symlink-aware check that must accompany it before any filesystem mutation.
 */
export function resolveUnder(root: string, relative: string): string {
  if (path.isAbsolute(relative)) {
    throw new DomainError('path_outside_root', 'path_outside_root: absolute paths are forbidden', false)
  }
  const base = path.resolve(root)
  const candidate = path.resolve(base, relative)
  if (candidate === base || !candidate.startsWith(base + path.sep)) {
    throw new DomainError('path_outside_root', 'path_outside_root: path escapes configured root', false)
  }
  return candidate
}

/** Same containment rule for an already-absolute path (e.g. a `file_path` Librarr reported). */
export function assertUnder(root: string, absolute: string): string {
  const base = path.resolve(root)
  const candidate = path.resolve(absolute)
  if (candidate === base || !candidate.startsWith(base + path.sep)) {
    throw new DomainError('path_outside_root', 'path_outside_root: path escapes configured root', false)
  }
  return candidate
}

/**
 * Symlink-aware confinement: resolves the deepest EXISTING ancestor of `candidate` through
 * `fs.realpath` and requires the result to still sit under `root`'s realpath. Catches the
 * case a lexical check cannot -- a real directory inside the root whose target is outside it.
 * Non-existent leaf segments are fine (that is the normal create-destination case).
 */
export async function assertRealPathUnder(root: string, candidate: string): Promise<string> {
  const realRoot = await fs.realpath(path.resolve(root))
  let probe = path.resolve(candidate)
  const trailing: string[] = []
  for (;;) {
    let real: string
    try {
      real = await fs.realpath(probe)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = path.dirname(probe)
      if (parent === probe) {
        throw new DomainError('path_outside_root', 'path_outside_root: no existing ancestor under root', false)
      }
      trailing.unshift(path.basename(probe))
      probe = parent
      continue
    }
    const rebuilt = path.resolve(real, ...trailing)
    if (rebuilt !== realRoot && !rebuilt.startsWith(realRoot + path.sep)) {
      throw new DomainError('path_outside_root', 'path_outside_root: realpath escapes configured root', false)
    }
    return rebuilt
  }
}

const ILLEGAL_CHARS = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])

/** Replaces reserved filesystem characters and C0 control codes with spaces. Written as an
 * explicit scan rather than a regex character class so no literal control byte ever has to
 * appear in this source file. */
function blankIllegal(value: string): string {
  let out = ''
  for (const ch of value) {
    out += ILLEGAL_CHARS.has(ch) || ch.codePointAt(0)! < 0x20 ? ' ' : ch
  }
  return out
}

/**
 * Reduces one metadata string to a single safe path segment.
 *
 * `:` becomes ` - ` rather than a space, so `Project: Hail Mary` yields `Project - Hail Mary`
 * (the plan document's own expected value; its inline sanitizer snippet mapped every illegal
 * character to a space and contradicted that expectation -- the expectation is what we honor).
 * Trailing dots and spaces are stripped because Windows/SMB shares reject them, and the
 * result is capped so deep destination paths stay under filesystem limits.
 */
export function sanitizeSegment(value: string): string {
  const withSeparators = (value ?? '').replace(/\s*:\s*/g, ' - ')
  const cleaned = blankIllegal(withSeparators)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 120)
    .trim()
  return cleaned || 'Unknown'
}

/**
 * The gateway-owned final destination: sanitized `Author/Title` under the mapped ABS library
 * root, per 02-SETTLED-DECISIONS.md. Deliberately NOT a mirror of Librarr's staging layout --
 * see docs/handoff/correlation-note.md section 5: Librarr's staging segments come from a
 * positional split of the release name and may be transposed or wrong.
 *
 * `disambiguator` appends the deterministic ` [<prefix>]` suffix, used only when the
 * unsuffixed destination already exists and belongs to a different acquisition.
 */
export function bookDestination(libraryRoot: string, author: string, title: string, disambiguator?: string): string {
  const safeTitle = disambiguator ? `${sanitizeSegment(title)} [${sanitizeSegment(disambiguator)}]` : sanitizeSegment(title)
  return resolveUnder(libraryRoot, path.join(sanitizeSegment(author), safeTitle))
}

/** The stable id prefix used for ` [<prefix>]` destination disambiguation. */
export function destinationSuffix(acquisitionId: string): string {
  return acquisitionId.replace(/^acq_/, '').slice(0, 8)
}
