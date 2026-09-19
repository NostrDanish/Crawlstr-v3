/**
 * Relay capability probing — NIP-11 relay information documents.
 *
 * A relay's NIP-11 document tells us what it supports before we commit to
 * it: `supported_nips` (NIP-50 = search) and, on SIP-01-aware relays, the
 * `uncaged_index` block (spec §15) describing the indexed document kinds and
 * available operators.
 *
 * The probe is a plain HTTPS GET with an `Accept: application/nostr+json`
 * header, direct first, CORS-proxy fallback (same pattern as the fetcher).
 */

import { CORS_PROXY_TEMPLATE } from './fetcher';
import { isPubliclyFetchable } from './safety';

export interface RelayCapabilities {
  url: string;
  /** True when the relay answered a NIP-11 document at all. */
  online: boolean;
  /** NIP-50 search support. */
  nip50: boolean;
  /** SIP-01-aware (publishes the uncaged_index NIP-11 block). */
  sip01: boolean;
  /** Relay-reported name, when present. */
  name?: string;
  /** Round-trip latency of the probe. */
  latencyMs: number;
  /** The relay's supported NIP list, when reported. */
  supportedNips?: number[];
  /** The uncaged_index block verbatim, when present. */
  sip01Scope?: Record<string, unknown>;
}

async function fetchRelayInfo(url: string): Promise<{ json: Record<string, unknown>; latencyMs: number } | null> {
  // NIP-11: the document lives at the relay's HTTP(S) endpoint.
  const httpUrl = url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');

  // SSRF guard — relay URLs are sourced from untrusted NIP-66 network
  // events (anyone can publish a kind 30166 pointing at 169.254.169.254).
  // Refuse non-public targets before ANY request, direct or proxied
  // (audit finding #2).
  if (!isPubliclyFetchable(httpUrl)) {
    console.debug('[Crawler] Refused non-public relay probe URL:', httpUrl);
    return null;
  }

  const tryOnce = async (requestUrl: string): Promise<{ json: Record<string, unknown>; latencyMs: number } | null> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    const startedAt = Date.now();
    try {
      const response = await fetch(requestUrl, {
        signal: controller.signal,
        mode: 'cors',
        credentials: 'omit',
        headers: { Accept: 'application/nostr+json' },
      });
      if (!response.ok) return null;
      const json = await response.json();
      if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
      return { json: json as Record<string, unknown>, latencyMs: Date.now() - startedAt };
    } finally {
      clearTimeout(timeoutId);
    }
  };

  // Direct first.
  try {
    const direct = await tryOnce(httpUrl);
    if (direct) return direct;
  } catch {
    // CORS or network — fall through to the proxy.
  }

  // Proxy fallback.
  try {
    return await tryOnce(CORS_PROXY_TEMPLATE.replace('{href}', encodeURIComponent(httpUrl)));
  } catch {
    return null;
  }
}

/** Probe a relay's NIP-11 document and report what it supports. */
export async function probeRelay(url: string): Promise<RelayCapabilities> {
  const result = await fetchRelayInfo(url);

  if (!result) {
    return { url, online: false, nip50: false, sip01: false, latencyMs: 0 };
  }

  const { json, latencyMs } = result;
  const supportedNips = Array.isArray(json.supported_nips)
    ? json.supported_nips.filter((n): n is number => typeof n === 'number')
    : undefined;

  const sip01Scope =
    json.uncaged_index && typeof json.uncaged_index === 'object' && !Array.isArray(json.uncaged_index)
      ? (json.uncaged_index as Record<string, unknown>)
      : undefined;

  return {
    url,
    online: true,
    nip50: supportedNips?.includes(50) ?? false,
    sip01: sip01Scope?.sip01 === true,
    name: typeof json.name === 'string' ? json.name.slice(0, 80) : undefined,
    latencyMs,
    supportedNips,
    sip01Scope,
  };
}

/** Probe several relays in parallel (each with its own timeout). */
export async function probeRelays(urls: string[]): Promise<RelayCapabilities[]> {
  return Promise.all(urls.map((url) => probeRelay(url)));
}
