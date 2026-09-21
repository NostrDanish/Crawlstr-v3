/**
 * Bounded retry backoff for transient fetch failures.
 *
 * v1 retried every failure the same way (3 flat attempts, then silently
 * dropped the job — and forgot it, so the next discovery re-fetched it).
 * v2 classifies failures first (see fetcher.ts: permanent vs transient) and
 * applies exponential backoff WITH JITTER to transient ones only:
 *
 *   attempt 1 → ~1 min, attempt 2 → ~2 min, attempt 3 → ~4 min, … capped
 *
 * Permanent failures (4xx, non-HTML, oversize, SSRF refusals) never pass
 * through here — they become negative-cache entries immediately.
 */

const BASE_MS = 60_000;
const MAX_MS = 60 * 60_000; // 1 hour
const MAX_ATTEMPTS = 5;

/** Backoff delay before retry `attempt` (1-based), with ±20% jitter.
 *  The cap is applied AFTER jitter so a retry never waits longer than
 *  MAX_MS — capping before jittering let a 1-hour sleep inflate to 72 min. */
export function retryBackoffMs(attempt: number): number {
  const exp = BASE_MS * 2 ** Math.max(0, attempt - 1);
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.min(MAX_MS, Math.floor(exp * jitter));
}

/** True while a transient failure is still worth retrying. */
export function isRetryable(attempt: number): boolean {
  return attempt < MAX_ATTEMPTS;
}

export const MAX_TRANSIENT_ATTEMPTS = MAX_ATTEMPTS;
