/**
 * Crawl-trap guards (v2 module — stronger than v1's looksLikeTrap regexes).
 *
 * At network scale the queue must defend itself: calendar generators,
 * session-id URLs, endless paginators and internal search pages create
 * effectively infinite URL space that would eat the entire crawl budget.
 * Seeds and curated starts bypass these guards (they are the human's
 * explicit choice); guards apply to *discovered* URLs (link following,
 * feeds, sitemaps).
 *
 * Heuristics are deliberately conservative: a false positive costs one page,
 * a false negative costs infinite crawl budget.
 */

/** Query keys that identify per-visitor session state — never indexable. */
const SESSION_KEYS = new Set([
  'sid', 'session', 'sessionid', 'sessid', 'phpsessid', 'jsessionid',
  'jssessionid', // common JSESSIONID double-S variant seen in the wild
  'aspsessionid', 'asp.net_sessionid', 'cfid', 'cftoken', 'zenid', 'oscsid',
]);

/** Path segments that generate unbounded URL space. */
const TRAP_SEGMENTS = new Set([
  'calendar', 'cart', 'checkout', 'basket',
]);

/**
 * True when a URL looks like a crawl trap / infinite-space generator.
 * Input should already be SIP-01-normalized.
 */
export function isLikelyCrawlTrap(normalizedUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(normalizedUrl);
  } catch {
    return true;
  }

  // 1. Session-state query keys.
  for (const key of url.searchParams.keys()) {
    if (SESSION_KEYS.has(key.toLowerCase())) return true;
  }

  // 2. Absurd query complexity (filter-combination generators).
  if ([...url.searchParams.keys()].length > 6) return true;

  const segments = url.pathname.split('/').filter(Boolean);
  const lowered = segments.map((s) => s.toLowerCase());

  // 3. Trap path segments.
  if (lowered.some((s) => TRAP_SEGMENTS.has(s))) return true;

  // 4. Repeating-segment generator loops.
  //    Period 1: same segment 3+ times in a row (/a/a/a).
  //    Period 2: an alternating pair looping 2+ times (/a/b/a/b/a) —
  //    calendar/facet generators produce exactly this shape.
  for (let i = 2; i < lowered.length; i++) {
    if (lowered[i] === lowered[i - 1] && lowered[i] === lowered[i - 2]) return true;
  }
  for (let i = 3; i < lowered.length; i++) {
    if (lowered[i] === lowered[i - 2] && lowered[i - 1] === lowered[i - 3]) return true;
  }

  // 5. Very long pure-numeric path segment (9+ digits) — counter space.
  if (lowered.some((s) => /^\d{9,}$/.test(s))) return true;

  // 6. Extreme depth.
  if (segments.length > 8) return true;

  return false;
}

/**
 * Per-domain cap on *discovered* URLs: one host must not flood the queue
 * through link following (a sitemap-less crawler trap, or a very large
 * single site). Seeds are exempt — they are the human's explicit choice.
 */
export class DomainIntakeGuard {
  private counts = new Map<string, number>();

  constructor(private readonly maxPerDomain: number) {}

  /** True when this URL may still be accepted. */
  allow(normalizedUrl: string): boolean {
    let host: string;
    try {
      host = new URL(normalizedUrl).hostname;
    } catch {
      return false;
    }
    const count = this.counts.get(host) ?? 0;
    if (count >= this.maxPerDomain) return false;
    this.counts.set(host, count + 1);
    return true;
  }

  /** Current count for a host (dashboard/testing). */
  countFor(normalizedUrl: string): number {
    try {
      return this.counts.get(new URL(normalizedUrl).hostname) ?? 0;
    } catch {
      return 0;
    }
  }
}
