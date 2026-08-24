import { describe, expect, it } from 'vitest'
import { mayAdvance, normalizeLibrarrStatus } from './statusNormalization'

describe('normalizeLibrarrStatus', () => {
  it.each([
    ['queued', 0, 'submitted'],
    ['downloading', 72.4, 'downloading'],
    ['importing', 100, 'processing'],
    ['error', 150, 'failed'],
    ['dead_letter', -2, 'failed'],
    ['completed', 100, 'processing'],
    ['some_unknown_status', 5, 'needs_attention']
  ])('maps %s to %s', (status, progress, expected) => {
    expect(normalizeLibrarrStatus({ status, progress })).toMatchObject({
      state: expected,
      progressPercent: Math.min(100, Math.max(0, progress))
    })
  })

  it('defaults progress to 0 when Librarr omits it', () => {
    expect(normalizeLibrarrStatus({ status: 'downloading' })).toMatchObject({ progressPercent: 0 })
  })
})

describe('mayAdvance', () => {
  it('allows forward progress through the pipeline', () => {
    expect(mayAdvance('submitted', 'downloading')).toBe(true)
    expect(mayAdvance('downloading', 'processing')).toBe(true)
  })

  it('rejects a regressive provider status', () => {
    expect(mayAdvance('processing', 'downloading')).toBe(false)
    expect(mayAdvance('downloading', 'submitted')).toBe(false)
  })

  it('always allows failed/needs_attention/cancelled regardless of rank', () => {
    expect(mayAdvance('downloading', 'failed')).toBe(true)
    expect(mayAdvance('processing', 'needs_attention')).toBe(true)
    expect(mayAdvance('submitted', 'cancelled')).toBe(true)
  })

  it('never advances out of a terminal state', () => {
    expect(mayAdvance('failed', 'downloading')).toBe(false)
    expect(mayAdvance('cancelled', 'submitted')).toBe(false)
  })
})
