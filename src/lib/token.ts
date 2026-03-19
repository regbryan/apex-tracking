import { randomBytes } from 'crypto'

/** Number of random bytes — produces a 32-character hex string */
const TOKEN_BYTES = 16

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex')
}
