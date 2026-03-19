import { describe, it, expect } from 'vitest'
import { validateBearerToken } from '@/lib/auth'

const REAL_SECRET = 'a'.repeat(64) // 64-char hex-like secret (realistic length)

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

  it('returns false for near-miss token (correct length, wrong last char)', () => {
    const secret = REAL_SECRET
    const nearMiss = secret.slice(0, -1) + (secret.endsWith('a') ? 'b' : 'a')
    expect(validateBearerToken(`Bearer ${nearMiss}`, secret)).toBe(false)
  })

  it('handles realistic full-length secret correctly', () => {
    expect(validateBearerToken(`Bearer ${REAL_SECRET}`, REAL_SECRET)).toBe(true)
  })
})
