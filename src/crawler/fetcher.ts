// HTTP fetcher — THE network egress for page/feed/sitemap/robots traffic.
//
// A browser cannot read cross-origin responses unless the target site sends
// CORS headers, and almost no site does. Direct fetches therefore fail with
// "TypeError: Failed to fetch" for the vast majority of the web, which made
// the crawler index nothing at all.
//
// Strategy: try direct first (fast, no third party sees the request), then
// fall back to a CORS proxy so the crawler actually works on real websites.
// The proxy is honest about the trade-off — see PROXY_NOTE below.
//
// v2 changes (over v1):
//   - Discriminated failure outcomes: `permanent` (4xx except 408/409/425/
//     429, non-HTML, oversize, SSRF) vs `transient` (5xx, retryable 4xx,
//     network, timeout). The engine retries transient failures with
//     exponential backoff (backoff.ts) and negative-caches permanent ones
//     (queue.ts) — v1 retried everything the same and then forgot it.
//   - Stream-capped reads: bodies stream through a byte counter and abort
//     at the size cap — no multi-hundred-MB main-thread allocations — and
//     the meter counts REAL bytes read off the wire, kept or discarded.

import { isPubliclyFetchable } from './safety';
import { recordFetch } from './meter';

/** CORS proxy used when a direct cross-origin fetch is blocked. */
export const CORS_PROXY_TEMPLATE = 'https://proxy.shakespeare.diy/?url={href}';

/**
 * Honest disclosure for the UI: when the proxy is used, the proxy operator
 * sees which URL was fetched (not who searched for it, and no user identity).
 */
export const PROXY_NOTE =
  'When a site blocks direct browser access (CORS), the request is routed through a CORS proxy. The proxy operator can see which URLs are fetched.';

export interface FetchResult {
  html: string;
  status: number;
  contentType: string;
  /** Real bytes read off the wire. */
  size: number;
  /** True when the page had to be retrieved through the CORS proxy. */
  viaProxy: boolean;
}

export interface FetchOptions {
  maxSizeKB?: number;
  /** Allow falling back to the CORS proxy. Default true. */
  allowProxy?: boolean;
  timeoutMs?: number;
}

/** Failure classification — drives the engine's retry/backoff decisions. */
export type FetchFailure =
  | {
      kind: 'permanent';
      reason: 'http-4xx' | 'non-html' | 'oversize' | 'ssrf' | 'unsupported-scheme';
      status?: number;
    }
  | {
      kind: 'transient';
      reason: 'http-5xx' | 'http-4xx-retryable' | 'network' | 'timeout';
      status?: number;
    };

export type FetchOutcome =
  | { ok: true; page: FetchResult }
  | { ok: false; failure: FetchFailure };

/**
 * 4xx statuses that are NOT permanent: the request may succeed later, so
 * the engine's bounded transient retry applies (everything else 4xx —
 * 400/401/403/404/410/… — is a permanent negative-cache entry):
 *   408 Request Timeout   — server gave up; retry may land
 *   409 Conflict          — optimistic-concurrency / permafrost-style
 *   425 Too Early         — early-data replay protection
 *   429 Too Many Requests — rate limit; retry after backoff
 */
export const RETRYABLE_4XX: ReadonlySet<number> = new Set([408, 409, 425, 429]);

function proxyUrl(url: string): string {
  return CORS_PROXY_TEMPLATE.replace('{href}', encodeURIComponent(url));
}

/**
 * Read a response body under a byte cap. Streams when streams are available
 * (aborting at the cap — the budget is about what we consumed, not what we
 * kept), falling back to a buffered read otherwise. Every byte read is
 * metered. Returns null when the body exceeds the cap.
 */
async function readBody(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; bytes: number } | null> {
  // Grace beyond the cap: multi-byte characters can inflate the decoded
  // string past the encoded byte count, and we check the decoded size too.
  const hardCap = maxBytes + 64 * 1024;

  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    let text = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > hardCap) {
          await reader.cancel().catch(() => {});
          recordFetch(received);
          return null;
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      recordFetch(received);
      if (new TextEncoder().encode(text).length > maxBytes) return null;
      return { text, bytes: received };
    } catch (error) {
      recordFetch(received);
      throw error;
    }
  }

  // Fallback: buffered read (jsdom, older engines).
  const text = await response.text();
  recordFetch(text.length);
  if (text.length > maxBytes) return null;
  return { text, bytes: text.length };
}

interface RawFetch {
  html: string;
  status: number;
  contentType: string;
  bytes: number;
}

type PermanentFailure = Extract<FetchFailure, { kind: 'permanent' }>;

type AttemptResult =
  | { ok: true; raw: RawFetch }
  | { ok: false; failure: PermanentFailure };

/**
 * Single fetch attempt. Throws only on retryable HTTP statuses (5xx,
 * 408/409/425/429) and network-level failure (CORS, DNS, reset) and timeout
 * (AbortError); everything else returns a classified permanent failure.
 */
async function attempt(
  requestUrl: string,
  maxSizeKB: number,
  timeoutMs: number,
  /** True on the direct path — response.url is then the real final URL. */
  checkRedirectTarget: boolean,
): Promise<AttemptResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(requestUrl, {
      mode: 'cors',
      credentials: 'omit',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    if (!response.ok) {
      if (response.status >= 500 || RETRYABLE_4XX.has(response.status)) {
        throw httpError(response.status); // transient
      }
      // Any other 4xx is permanent.
      return { ok: false, failure: { kind: 'permanent', reason: 'http-4xx', status: response.status } };
    }

    // Redirect re-check: a public URL can 302 into private space. On the
    // direct path, response.url is where we actually landed — guard it.
    // (On the proxied path the proxy follows redirects server-side; the
    // proxy operator owns that check, and we say so in the UI.)
    if (checkRedirectTarget && response.url && response.url !== requestUrl) {
      if (!isPubliclyFetchable(response.url)) {
        console.debug('[Crawler] Refused: redirect into non-public address', response.url);
        return { ok: false, failure: { kind: 'permanent', reason: 'ssrf' } };
      }
    }

    const contentType = response.headers.get('content-type') ?? '';

    // Proxies sometimes omit/rewrite content-type. Accept empty and sniff later.
    const looksHtml =
      contentType === '' ||
      contentType.includes('text/html') ||
      contentType.includes('application/xhtml') ||
      contentType.includes('text/plain');
    if (!looksHtml) {
      return { ok: false, failure: { kind: 'permanent', reason: 'non-html', status: response.status } };
    }

    const body = await readBody(response, maxSizeKB * 1024);
    if (!body) {
      // Oversize — bytes already metered.
      return { ok: false, failure: { kind: 'permanent', reason: 'oversize', status: response.status } };
    }

    // Sniff: make sure this is actually markup before handing it to the parser.
    if (!/<\s*(!doctype|html|head|body|title|meta|div|a|p)\b/i.test(body.text.slice(0, 4000))) {
      return { ok: false, failure: { kind: 'permanent', reason: 'non-html', status: response.status } };
    }

    return {
      ok: true,
      raw: {
        html: body.text,
        status: response.status,
        contentType: contentType || 'text/html',
        bytes: body.bytes,
      },
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Marker so the caller can distinguish HTTP-status throws from network errors. */
class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
    this.name = 'HttpStatusError';
  }
}

function httpError(status: number): HttpStatusError {
  return new HttpStatusError(status);
}

/**
 * Fetch an XML-ish document (RSS/Atom feed, sitemap) — same direct-then-proxy
 * strategy as fetchPage. Returns raw text, or null (feeds/sitemaps are
 * opportunistic discovery; the engine does not retry them).
 */
export async function fetchXml(url: string, maxSizeKB = 1024): Promise<string | null> {
  // SSRF guard — never hand a non-public target to fetch, direct or proxied.
  if (!isPubliclyFetchable(url)) {
    console.debug('[Crawler] Refused non-public URL:', url);
    return null;
  }

  const tryOnce = async (requestUrl: string, direct: boolean): Promise<string | null> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(requestUrl, {
        mode: 'cors',
        credentials: 'omit',
        redirect: 'follow',
        signal: controller.signal,
        headers: { Accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml,text/html,*/*;q=0.8' },
      });
      if (!response.ok) return null;

      // Redirect re-check on the direct path (see fetchPage for rationale).
      if (direct && response.url && response.url !== requestUrl && !isPubliclyFetchable(response.url)) {
        console.debug('[Crawler] Refused: redirect into non-public address', response.url);
        return null;
      }

      const body = await readBody(response, maxSizeKB * 1024);
      return body?.text ?? null;
    } finally {
      clearTimeout(timeoutId);
    }
  };

  try {
    return await tryOnce(url, true);
  } catch {
    // CORS — fall through to the proxy.
  }

  try {
    return await tryOnce(proxyUrl(url), false);
  } catch {
    return null;
  }
}

export async function fetchPage(
  url: string,
  optionsOrMaxSizeKB: FetchOptions | number = {},
): Promise<FetchOutcome> {
  const options: FetchOptions =
    typeof optionsOrMaxSizeKB === 'number'
      ? { maxSizeKB: optionsOrMaxSizeKB }
      : optionsOrMaxSizeKB;

  const maxSizeKB = options.maxSizeKB ?? 2048;
  const allowProxy = options.allowProxy ?? true;
  const timeoutMs = options.timeoutMs ?? 15000;

  // SSRF guard — never hand a non-public target to fetch, direct or proxied.
  // This is the primary check; the in-flight redirect check is secondary.
  if (!isPubliclyFetchable(url)) {
    console.debug('[Crawler] Refused non-public URL:', url);
    return { ok: false, failure: { kind: 'permanent', reason: 'ssrf' } };
  }

  // --- 1. Direct fetch (works only for CORS-enabled sites) ---
  try {
    const direct = await attempt(url, maxSizeKB, timeoutMs, true);
    if (direct.ok) {
      return { ok: true, page: { ...direct.raw, size: direct.raw.bytes, viaProxy: false } };
    }
    // Reachable but permanently unusable (4xx, non-HTML, too large, SSRF
    // redirect) — the proxy would get the same answer, don't retry.
    return { ok: false, failure: direct.failure };
  } catch (error) {
    const classified = classifyThrow(error);
    if (classified) return { ok: false, failure: classified };
    if (!allowProxy) {
      console.debug('[Crawler] Blocked (CORS) and proxy disabled:', url);
      return { ok: false, failure: { kind: 'transient', reason: 'network' } };
    }
    // Network-level failure. For cross-origin requests this is almost always
    // CORS, which the proxy can solve.
  }

  // --- 2. Proxy fallback ---
  try {
    const proxied = await attempt(proxyUrl(url), maxSizeKB, timeoutMs, false);
    if (proxied.ok) {
      return { ok: true, page: { ...proxied.raw, size: proxied.raw.bytes, viaProxy: true } };
    }
    return { ok: false, failure: proxied.failure };
  } catch (error) {
    const classified = classifyThrow(error);
    if (classified) return { ok: false, failure: classified };
    console.debug('[Crawler] Proxy failed:', url);
    return { ok: false, failure: { kind: 'transient', reason: 'network' } };
  }
}

/** Map a thrown attempt() error to a transient failure, or null when it
 *  isn't one of ours (shouldn't happen — defensive). */
function classifyThrow(error: unknown): FetchFailure | null {
  if (error instanceof HttpStatusError) {
    return {
      kind: 'transient',
      reason: error.status >= 500 ? 'http-5xx' : 'http-4xx-retryable',
      status: error.status,
    };
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return { kind: 'transient', reason: 'timeout' };
  }
  return null;
}
