/**
 * Relay configuration — matches the Searchstr/UNCAGED ecosystem plus
 * Crawlstr's own publish set.
 *
 * Index observations (SIP-01, kind 39697) are published to:
 * 1. The SIP-01-aware index relays (validating, NIP-50 operators)
 * 2. The NIP-50 search relay pool (so search engines see them immediately)
 * 3. Public write relays (so they replicate widely)
 *
 * The user can extend the publish set with custom relays (localStorage);
 * custom relays merge into getIndexPublishRelays() / getSearchRelays().
 */

/**
 * SIP-01-aware index relays (the validating relay cohort from the SIP-01
 * ecosystem — they index kind 39697 and speak the web-search operators).
 */
export const SIP01_RELAYS = [
  'wss://relay-na1.metanomalist.com/',
  'wss://test-sip-relay.sip-01test.workers.dev/',
  'wss://sip-relay-2.sip-booster-relay.workers.dev/',
  'wss://sip-relay-3.uncaged-sip.workers.dev/',
  'wss://sip-relay-4.sip-relay-4.workers.dev/',
];

/**
 * Relays that support NIP-50 search queries.
 * Same defaults as UNCAGED-ENGINE / 0xSearchstr.
 */
export const SEARCH_RELAYS = [
  'wss://relay.nostr.band/',
  'wss://relay.ditto.pub/',
  'wss://search.nos.today/',
  'wss://relay.noswhere.com/',
];

/**
 * Extra relays that index observations are published to, beyond the
 * search pool, so observations propagate widely.
 */
export const INDEX_WRITE_RELAYS = [
  ...SIP01_RELAYS,
  'wss://relay.ditto.pub/',
  'wss://jskitty.cat/nostr',
  'wss://relay.primal.net/',
  'wss://relay.damus.io/',
  'wss://nostr.hifish.org/',
  // Tor-only relay. Reachable from Tor Browser, where .onion is a secure
  // context so plain ws:// is fine (the Tor circuit provides the encryption).
  // On clearnet browsers the hostname never resolves and the connection is
  // skipped by the pool — harmless to include.
  'ws://acuy3mjnv26tkyaaucndlxmg2ocntz4rtebhavk57vgruozm42iaznqd.onion/',
];

/**
 * Relays that node heartbeats (kind 16919) are published to — a
 * deliberately SMALL general-write subset. The SIP-01-validating relays
 * only accept kind 39697 ("event kind 16919 not allowed on this relay")
 * and search.nos.today is read-only, so sending heartbeats to the full
 * observation set just burns rate limits and spams the console.
 */
export const HEARTBEAT_RELAYS = [
  'wss://relay.ditto.pub/',
  'wss://jskitty.cat/nostr',
  'wss://relay.primal.net/',
  'wss://relay.damus.io/',
  'wss://nostr.hifish.org/',
];

/* ------------------------------------------------------------------ */
/* Custom relays (user-managed, localStorage)                          */
/* ------------------------------------------------------------------ */

const LS_CUSTOM_RELAYS = 'crawlstr:custom-relays';

function readCustomRelays(): string[] {
  try {
    const raw = localStorage.getItem(LS_CUSTOM_RELAYS);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === 'string') : [];
  } catch {
    return [];
  }
}

function writeCustomRelays(urls: string[]): void {
  try {
    localStorage.setItem(LS_CUSTOM_RELAYS, JSON.stringify(urls));
  } catch {
    // Storage unavailable — non-fatal.
  }
}

/** Normalize a relay URL: ws/wss only, trailing slash on bare hosts. */
export function normalizeRelayUrl(input: string): string | null {
  let url = input.trim();
  if (!url) return null;
  if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
    url = `wss://${url}`;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') return null;
    const path = parsed.pathname === '/' ? '/' : parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${path}`;
  } catch {
    return null;
  }
}

/** Get the user's custom relays. */
export function getCustomRelays(): string[] {
  return readCustomRelays();
}

/** All relay URLs the app considers "built in" (can't be removed). */
export function getBuiltinRelays(): string[] {
  const seen = new Set<string>();
  const pool: string[] = [];
  for (const url of [...SEARCH_RELAYS, ...INDEX_WRITE_RELAYS]) {
    if (!seen.has(url)) {
      seen.add(url);
      pool.push(url);
    }
  }
  return pool;
}

/** Add a custom relay. Returns the normalized URL, or null if invalid/duplicate. */
export function addCustomRelay(input: string): string | null {
  const normalized = normalizeRelayUrl(input);
  if (!normalized) return null;
  const current = readCustomRelays();
  if (current.includes(normalized) || getBuiltinRelays().includes(normalized)) {
    return null;
  }
  writeCustomRelays([...current, normalized]);
  return normalized;
}

/** Remove a custom relay (built-ins can't be removed). */
export function removeCustomRelay(url: string): void {
  writeCustomRelays(readCustomRelays().filter((u) => u !== url));
}

/**
 * Relays that index observations are published to: SIP-01 relays first,
 * then the NIP-50 search pool, then write relays, then user customs.
 * Deduped.
 */
export function getIndexPublishRelays(): string[] {
  const seen = new Set<string>();
  const pool: string[] = [];
  for (const url of [...SEARCH_RELAYS, ...INDEX_WRITE_RELAYS, ...readCustomRelays()]) {
    if (!seen.has(url)) {
      seen.add(url);
      pool.push(url);
    }
  }
  return pool;
}

/** Relays that node heartbeats (kind 16919) go to — see HEARTBEAT_RELAYS. */
export function getHeartbeatRelays(): string[] {
  return [...HEARTBEAT_RELAYS];
}
