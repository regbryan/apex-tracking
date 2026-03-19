import { describe, it, expect } from 'vitest'
import { validateBearerToken } from '@/lib/auth'

describe('validateBearerToken', () => {
  it('returns true when header matches secret', () => {
    expect(validateBearerToken('Bearer mysecret', 'mysecret')).toBe(true)
  })

  it('returns false when header is missing', () => {
    expect(validateBearerToken(null, 'mysecret')).toBe(false)
  })

  it('returns false when token does not match', () => {
    expect(validateBearerToken('Bearer wrongsecret', 'mysecret')).toBe(false)
  })

  it('returns false when format is wrong (no Bearer prefix)', () => {
    expect(validateBearerToken('mysecret', 'mysecret')).toBe(false)
  })
})
