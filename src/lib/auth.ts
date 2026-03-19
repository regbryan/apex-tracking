export function validateBearerToken(
  authHeader: string | null,
  expectedSecret: string
): boolean {
  if (!authHeader) return false
  const parts = authHeader.split(' ')
  if (parts.length !== 2 || parts[0] !== 'Bearer') return false
  return parts[1] === expectedSecret
}
