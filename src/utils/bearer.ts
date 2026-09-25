import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Suffolk: constant-time check of an "Authorization: Bearer <token>" header.
 * Both sides are hashed first so the comparison never leaks the token length.
 */
export function bearerMatches(header: string | undefined, expected: string): boolean {
  if (!expected || !header) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return false;
  const a = createHash('sha256').update(m[1].trim()).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
