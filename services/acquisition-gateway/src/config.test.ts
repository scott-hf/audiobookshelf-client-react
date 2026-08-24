import { expect, it } from 'vitest'
import { loadConfig } from './config'

it('parses library mappings and rejects overlapping roots', () => {
  const base = {
    ABS_INTERNAL_URL: 'http://abs:13378',
    ABS_SERVICE_TOKEN: 'secret',
    LIBRARR_INTERNAL_URL: 'http://librarr:5050',
    LIBRARR_API_KEY: 'key',
    GATEWAY_DB_PATH: '/data/gateway.sqlite',
    STAGING_ROOT: '/media/staging'
  }
  expect(loadConfig({ ...base, LIBRARY_MAPPINGS_JSON: '{"lib1":"/media/library"}' }).libraries.get('lib1')).toBe(
    '/media/library'
  )
  expect(() => loadConfig({ ...base, LIBRARY_MAPPINGS_JSON: '{"lib1":"/media/staging/library"}' })).toThrow('overlap')
})
