import { describe, it, expect } from 'vitest'
import { generateToken } from '@/lib/token'

describe('generateToken', () => {
  it('returns a 32-character hex string', () => {
    const token = generateToken()
    expect(token).toMatch(/^[a-f0-9]{32}$/)
  })

  it('returns unique values on each call', () => {
    const tokens = new Set(Array.from({ length: 100 }, generateToken))
    expect(tokens.size).toBe(100)
  })
})
