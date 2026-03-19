import { timingSafeEqual } from 'crypto'

export function validateBearerToken(
  authHeader: string | null,
  expectedSecret: string
): boolean {
  if (!authHeader) return false
  const parts = authHeader.split(' ')
  if (parts.length !== 2 || parts[0] !== 'Bearer') return false
  try {
    const provided = Buffer.from(parts[1])
    const expected = Buffer.from(expectedSecret)
    if (provided.length !== expected.length) return false
    return timingSafeEqual(provided, expected)
  } catch {
    return false
  }
}
