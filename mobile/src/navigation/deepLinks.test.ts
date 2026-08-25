import { describe, expect, it } from 'vitest'
import { routeFromDeepLink } from './deepLinks'

describe('routeFromDeepLink', () => {
  it.each([
    ['https://books.example.com/library/lib1/item/abs1', '/library/lib1/item/abs1'],
    ['shelfdroid://library/lib1/discover', '/library/lib1/discover']
  ])('maps %s', (input, expected) => {
    expect(routeFromDeepLink(input)).toBe(expected)
  })

  it('rejects external or traversal links', () => {
    expect(routeFromDeepLink('https://evil.test/library/lib1/item/abs1')).toBeNull()
    expect(routeFromDeepLink('shelfdroid://library/../settings')).toBeNull()
  })

  it('rejects unknown schemes and malformed URLs', () => {
    expect(routeFromDeepLink('ftp://books.example.com/library/lib1/discover')).toBeNull()
    expect(routeFromDeepLink('not a url')).toBeNull()
  })

  it('rejects invalid id segments', () => {
    expect(routeFromDeepLink('https://books.example.com/library//item/abs1')).toBeNull()
    expect(routeFromDeepLink('shelfdroid://library/lib1/item/')).toBeNull()
  })
})
