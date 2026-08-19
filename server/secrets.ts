/**
 * Comparing a shared secret without leaking how much of it was right.
 *
 * `a !== b` on strings stops at the first character that differs, so the
 * time it takes to say no is a (very noisy) measure of how many leading
 * characters the caller guessed correctly. Over enough attempts that is a
 * way to walk a secret out one character at a time. Network jitter makes it
 * impractical against these endpoints in the real world, and it costs one
 * function to not have to argue about that.
 *
 * Both endpoints this guards — /api/alerts/ingest and /api/push/dispatch —
 * can reach every user of the app, so they get the careful comparison.
 */
import { timingSafeEqual } from 'node:crypto';

/**
 * True when `supplied` matches `expected`.
 *
 * Returns false — never throws, and never passes — when either side is
 * missing, so an unset secret cannot be satisfied by an absent header.
 * Lengths are compared first because timingSafeEqual requires equal-length
 * buffers; the length of a secret is not the part worth hiding.
 */
export const secretMatches = (
  supplied: string | undefined | null,
  expected: string | undefined | null
): boolean => {
  if (!supplied || !expected) return false;
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};
