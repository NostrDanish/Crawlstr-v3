/**
 * SIP-01 (Search Index Protocol) — Crawlstr publisher implementation.
 * Canonical spec: https://github.com/NostrDanish/SIP-01 (public/spec/SIP-01.md)
 *
 * Spec revision implemented: v1.2. The v1.2 revision audited NIP references
 * (NIP-33 folded into NIP-01; the `l` convention is NIP-32's, used here in the
 * bare two-letter form per §12.5) and added the §20 dependency table — the
 * wire format is unchanged and every v1/v1.1 event remains valid.
 *
 * Byte-compatible with the canonical reference port
 * (SIP-01 repo, src/lib/sip01-utils.ts), which is itself byte-compatible with:
 *   - 0xSearchstr / UNCAGED-ENGINE  src/lib/webIndex.ts   (publisher/reader)
 *   - UNCAGED-Index-Relay           src/web-document.ts     (validator)
 *
 * One addressable event (kind 39697) per (indexer pubkey, normalized URL):
 *   d = "widx:" + sha256(normalized_url)[0:32]   ← URL identity (§3)
 *   u = canonical URL, normalized per §7
 *   x = sha256(title + "\n" + description)       ← content identity (§8)
 *   v = "1"                                      ← schema version (§10)
 *   content = { title, description?, image? }
 *
 * The event NEVER contains a search query, a user identity, or anything
 * about who surfaced the page. Indexer identity = the event pubkey (§14).
 */

import type { NostrEvent } from '@nostrify/nostrify';

/** Web Index Observation kind (addressable range). */
export const SIP01_KIND = 39697;

/** Current schema version (the `v` tag). */
export const SIP01_SCHEMA_VERSION = '1';

/** d-tag namespace prefix (SIP-01 §3). */
export const SIP01_D_PREFIX = 'widx:';

/* Hard caps (spec §5/§6) */
export const MAX_URL_LEN = 2048;
export const MAX_TITLE_LEN = 300;
export const MAX_DESCRIPTION_LEN = 1000;
export const MAX_IMAGE_LEN = 2048;
export const MAX_ALT_LEN = 1000;
export const MAX_SOURCE_LEN = 100;
export const MAX_TOPICS = 8;

/** Tracking parameters stripped during normalization (spec §7 step 5). */
export const TRACKING_PARAMS: readonly string[] = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'dclid', 'mc_cid', 'mc_eid', 'igshid', 'ref_src',
  'spm', 'si',
];

const TRACKING_SET = new Set(TRACKING_PARAMS);

/** Topic tag shape (spec §6). */
export const TOPIC_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;

/** Extension keyword shape (spec §9.1 rule 5). */
export const EXTENSION_VALUE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,49}$/;

/** ISO 639-1 language code shape (spec §6, bare `l` tag per §12.5 / NIP-32). */
const LANG_RE = /^[a-z]{2}$/;

/** ISO 3166-1 alpha-2 country code shape (spec §9.2, `country` tag). */
const COUNTRY_RE = /^[a-zA-Z]{2}$/;

/**
 * Normalize a URL per SIP-01 §7. Implementations across the ecosystem MUST
 * produce byte-identical output for the same page or `d`-tag deduplication
 * breaks. Returns null for invalid or non-http(s) URLs.
 *
 * Verified against spec §13.1 test vectors:
 *   https://example.com/                                  -> https://example.com/
 *   HTTPS://WWW.Example.Com:443/page/?b=2&utm_source=x&a=1#top
 *                                                         -> https://example.com/page?a=1&b=2
 *   https://example.com/page                              -> https://example.com/page
 *   https://github.com/NostrDanish/Crwalstr               -> unchanged (path case-sensitive)
 */
export function normalizeIndexUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  // 2. Strip a leading www. (scheme/host are lowercased by the parser).
  url.hostname = url.hostname.replace(/^www\./, '');

  // 3. Default ports.
  if (
    (url.protocol === 'http:' && url.port === '80') ||
    (url.protocol === 'https:' && url.port === '443')
  ) {
    url.port = '';
  }

  // 4. Fragment never identifies content for indexing purposes.
  url.hash = '';

  // 5–6. Strip tracking params, keep everything else, sort deterministically.
  const params = [...url.searchParams.entries()]
    .filter(([key]) => !TRACKING_SET.has(key.toLowerCase()))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = '';
  for (const [key, value] of params) url.searchParams.append(key, value);

  // 7. Trailing slash on non-root paths.
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }

  return url.toString();
}

/** SHA-256 hex (lowercase) of a UTF-8 string. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** URL identity (spec §3): "widx:" + first 32 hex chars of sha256(normalized). */
export async function documentId(normalizedUrl: string): Promise<string> {
  const hex = await sha256Hex(normalizedUrl);
  return `${SIP01_D_PREFIX}${hex.slice(0, 32)}`;
}

/** Content identity (spec §8): sha256(title + "\n" + description). */
export async function contentHash(title: string, description = ''): Promise<string> {
  return sha256Hex(`${title}\n${description}`);
}

/**
 * Input for building an observation event. Extension tags follow the
 * registry in spec §9.2.
 */
export interface IndexObservationInput {
  url: string;
  title: string;
  description?: string;
  image?: string;
  tags?: string[];
  language?: string;
  published?: number;
  source?: string; // indexer software id, e.g. "crawlstr/v2"
  /* Extension registry (spec §9.2) — all optional, all ignored by
     consumers that don't know them. */
  type?: string;     // logical document type: page, article, repository, video, …
  platform?: string; // source platform: github, gitlab, youtube, …
  category?: string; // engine-defined content category
  network?: string;  // clearnet | tor | i2p (Crawlstr only ever emits clearnet)
  country?: string;  // ISO 3166-1 alpha-2
  mime?: string;     // document media type
}

export interface UnsignedIndexEvent {
  kind: number;
  content: string;
  tags: string[][];
}

/**
 * Build an unsigned web-index observation event.
 * Returns null when the input is unusable (bad URL, empty title).
 */
export async function buildIndexEvent(
  input: IndexObservationInput,
): Promise<UnsignedIndexEvent | null> {
  const normalized = normalizeIndexUrl(input.url);
  if (!normalized) return null;

  // §5: u tag length cap.
  if (normalized.length > MAX_URL_LEN) return null;

  const title = input.title.trim().slice(0, MAX_TITLE_LEN);
  if (!title) return null;

  const description = (input.description ?? '').trim().slice(0, MAX_DESCRIPTION_LEN);

  let image = (input.image ?? '').trim().slice(0, MAX_IMAGE_LEN);
  if (image && !/^https:\/\//i.test(image)) image = ''; // §11: images are https only

  const d = await documentId(normalized);
  const x = await contentHash(title, description);

  // §6: topics are lowercase keyword-shaped, deduped, max 8.
  const topics = (input.tags ?? [])
    .map((t) => t.toLowerCase().trim().replace(/\s+/g, '-'))
    .filter((t) => TOPIC_RE.test(t))
    .filter((t, i, arr) => arr.indexOf(t) === i)
    .slice(0, MAX_TOPICS);

  // §6: l must be a valid two-letter ISO 639-1 code; drop anything else.
  const language = (input.language ?? '').trim().toLowerCase();
  const validLanguage = LANG_RE.test(language) ? language : '';

  const content: Record<string, string> = { title };
  if (description) content.description = description;
  if (image) content.image = image;

  const alt = `Web index observation: ${title}`.slice(0, MAX_ALT_LEN);

  const tags: string[][] = [
    ['d', d],
    ['u', normalized],
    ...topics.map((t): string[] => ['t', t]),
    ...(validLanguage ? [['l', validLanguage] as string[]] : []),
    ['x', x],
    ['v', SIP01_SCHEMA_VERSION],
    // §6/validator: published must be unix seconds matching /^\d{1,16}$/ —
    // pre-1970 claimed dates (negative) would make validating relays reject
    // the whole event (UNCAGED web-document.ts:374). The sip-01-core
    // reference builder does NOT guard this, so crawlers must (finding C-1).
    ...(input.published && Number.isFinite(input.published) && input.published > 0
      ? [['published', String(Math.floor(input.published))] as string[]]
      : []),
    ...(input.source
      ? [['source', input.source.trim().slice(0, MAX_SOURCE_LEN)] as string[]]
      : []),
    ...extensionTags(input),
    ['alt', alt],
  ];

  return { kind: SIP01_KIND, content: JSON.stringify(content), tags };
}

/** Extension registry tags (spec §9.2), validated per §9.1 rule 5. */
function extensionTags(input: IndexObservationInput): string[][] {
  const tags: string[][] = [];

  for (const name of ['type', 'platform', 'category', 'network'] as const) {
    const value = input[name]?.trim().toLowerCase();
    if (value && EXTENSION_VALUE_RE.test(value)) tags.push([name, value]);
  }

  const country = input.country?.trim();
  if (country && COUNTRY_RE.test(country)) tags.push(['country', country.toUpperCase()]);

  const mime = input.mime?.trim().toLowerCase();
  if (mime && /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}(;\s*[^\s;=]+=[^\s;]+)*$/.test(mime)) {
    tags.push(['mime', mime]);
  }

  return tags;
}

/* ------------------------------------------------------------------------ */
/* Reader side (spec §18) — parse + verify inbound observations             */
/* ------------------------------------------------------------------------ */

const EXTENSION_TAG_NAMES = ['type', 'platform', 'category', 'network', 'country', 'mime'] as const;

/** A parsed, validated observation (reader view of a kind 39697 event). */
export interface IndexObservation {
  /** Document id (d tag). */
  d: string;
  /** Canonical URL (u tag, re-normalized per §7). */
  url: string;
  title: string;
  description: string;
  image?: string;
  topics: string[];
  language?: string;
  contentHash?: string;
  published?: number;
  source?: string;
  /** Registered extension tags present on the event (spec §9.2). */
  extensions: Record<string, string>;
  /** Event created_at — the observation time. */
  observedAt: number;
  /** Indexer pubkey (event author) — the real indexer identity (§14). */
  indexer: string;
  /** The raw event, for provenance. */
  event: NostrEvent;
}

function getTag(event: NostrEvent, name: string): string | undefined {
  return event.tags.find(([n]) => n === name)?.[1];
}

/**
 * Parse + validate a kind 39697 event. Returns null for anything malformed:
 * wrong kind, missing required fields, bad/overlong URL, unsupported schema
 * version (spec §10: consumers MUST ignore unknown `v`). Cheap synchronous
 * checks only — hash verification (d ↔ u, x ↔ content) is available via
 * verifyObservation() for readers that want spec §18 step 2.
 */
export function parseIndexEvent(event: NostrEvent): IndexObservation | null {
  if (event.kind !== SIP01_KIND) return null;

  const d = getTag(event, 'd');
  const url = getTag(event, 'u');
  const version = getTag(event, 'v');
  if (!d?.startsWith(SIP01_D_PREFIX) || !url || version !== SIP01_SCHEMA_VERSION) {
    return null;
  }
  if (url.length > MAX_URL_LEN) return null;

  const normalized = normalizeIndexUrl(url);
  if (!normalized) return null;

  let title: string;
  let description: string;
  let image: string | undefined;
  try {
    const parsed = JSON.parse(event.content) as Record<string, unknown>;
    title = typeof parsed.title === 'string' ? parsed.title.trim().slice(0, MAX_TITLE_LEN) : '';
    description =
      typeof parsed.description === 'string'
        ? parsed.description.trim().slice(0, MAX_DESCRIPTION_LEN)
        : '';
    if (typeof parsed.image === 'string' && /^https:\/\//i.test(parsed.image)) {
      image = parsed.image.slice(0, MAX_IMAGE_LEN);
    }
  } catch {
    return null;
  }
  if (!title) return null;

  const topics = event.tags
    .filter(([n]) => n === 't')
    .map(([, v]) => v)
    .filter((v) => TOPIC_RE.test(v))
    .slice(0, MAX_TOPICS);

  const language = getTag(event, 'l');

  const publishedTag = getTag(event, 'published');
  const published = publishedTag ? parseInt(publishedTag, 10) : NaN;

  const extensions: Record<string, string> = {};
  for (const name of EXTENSION_TAG_NAMES) {
    const value = getTag(event, name);
    if (value !== undefined) extensions[name] = value;
  }

  return {
    d,
    url: normalized,
    title,
    description,
    image,
    topics,
    language: language && LANG_RE.test(language) ? language : undefined,
    contentHash: getTag(event, 'x'),
    published: Number.isFinite(published) ? published : undefined,
    source: getTag(event, 'source'),
    extensions,
    observedAt: event.created_at,
    indexer: event.pubkey,
    event,
  };
}

/**
 * Full integrity check (spec §18 step 2): verify the d tag matches the
 * normalized u tag, and — when present — the x tag matches the content.
 * This is what stops a spoofed observation from squatting on a popular
 * document's d-tag with fake metadata. Async because of SHA-256.
 */
export async function verifyObservation(obs: IndexObservation): Promise<boolean> {
  const expectedD = await documentId(obs.url);
  if (obs.d !== expectedD) return false;

  if (obs.contentHash) {
    const expectedX = await contentHash(obs.title, obs.description);
    if (obs.contentHash !== expectedX) return false;
  }

  return true;
}
