// Crawler type definitions

import type { FeedLink } from './feed';

export interface CrawlJob {
  url: string;
  priority: number;
  depth: number;
  discoveredFrom?: string;
  attempts: number;
  lastAttempt?: number;
  nextAttempt?: number;
}

export interface ParsedPage {
  title: string;
  description: string;
  /** Representative image (og:image / twitter:image). */
  image?: string;
  /** Claimed publication time, unix seconds (SIP-01 `published` tag). */
  published?: number;
  /** RSS/Atom feeds linked from the page. */
  feeds: FeedLink[];
  /** Canonical URL the page claims for itself. */
  canonical: string;
  /** meta keywords, split and trimmed (max 8). */
  keywords: string[];
  text: string;
  language: string;
  links: string[];
  wordCount: number;
}

export interface CrawlResult {
  url: string;
  title: string;
  description: string;
  contentHash: string;
  language: string;
  links: string[];
  wordCount: number;
  crawledAt: number;
  status: number;
  contentType: string;
}

export interface CrawlerStats {
  pagesIndexed: number;
  queueSize: number;
  bandwidthUsed: number;
  uptime: number;
  errors: number;
  skipped: number;
  /** Pages that required the CORS proxy (most of the web). */
  viaProxy: number;
  /** Pages fetched directly because the site sends CORS headers. */
  viaDirect: number;
  /** Skipped because the site's robots.txt disallows crawling. */
  robotsBlocked: number;
  /** Could not be retrieved at all after retries (negative-cached). */
  fetchFailed: number;
  /** Skipped because identical content was already indexed. */
  duplicates: number;
  /** Skipped for having almost no extractable text (JS-rendered SPAs). */
  thinContent: number;
  /** New URLs discovered this session (links + feed entries + sitemap URLs). */
  urlsDiscovered: number;
  /** RSS/Atom feeds found this session. */
  feedsFound: number;
  /** Sitemaps found this session. */
  sitemapsFound: number;
  /** Signed observations held in the IndexedDB outbox awaiting relay
   *  connectivity (zero relay accepts at publish time). */
  outboxPending: number;
  /** Observations accepted by at least one relay (acked-only accounting —
   *  v1 counted "built", which lied when the network was down). */
  published: number;
  /** Refused before any request: private/loopback/link-local target (SSRF). */
  ssrfBlocked: number;
  /** Discovered URLs refused as crawl traps (session state, generators). */
  trapsBlocked: number;
  /** Successful adaptive recrawls (freshness.ts) this session. */
  recrawls: number;
}

/** Crawl budget presets — how much one session may do before auto-stopping. */
export type CrawlMode = 'quick' | 'site' | 'deep' | 'volunteer';

export const CRAWL_MODES: Record<CrawlMode, { label: string; maxPages: number; description: string }> = {
  quick:     { label: 'Quick Scan', maxPages: 5,   description: '1–5 pages, fast inspection' },
  site:      { label: 'Site Scan',  maxPages: 30,  description: '~30 pages, useful crawl' },
  deep:      { label: 'Deep Scan',  maxPages: 150, description: 'up to ~150 pages' },
  volunteer: { label: 'Volunteer',  maxPages: 0,   description: 'crawl until you stop it' },
};

export interface CrawlerSettings {
  wifiOnly: boolean;
  chargingOnly: boolean;
  respectRobots: boolean;
  /** Hourly bandwidth budget in MB. 0 = UNLIMITED (cap fully off — the
   *  crawler just runs). Default 25. */
  maxBandwidthMB: number;
  maxPagesPerHour: number;
  maxDepth: number;
  maxPageSizeKB: number;
  ecoMode: boolean;
  /** Follow RSS/Atom feeds found on pages. */
  followFeeds: boolean;
  /** Read sitemap.xml for discovery. */
  followSitemaps: boolean;
  /** Adaptive recrawls (freshness.ts): re-visit crawled pages on a
   *  change-detected schedule (24h → 30d) and republish the freshness
   *  signal. Default on — v1 let the index go stale forever. */
  recrawlEnabled: boolean;
}

export const DEFAULT_SETTINGS: CrawlerSettings = {
  wifiOnly: false,
  chargingOnly: false,
  respectRobots: true,
  maxBandwidthMB: 25,
  maxPagesPerHour: 100,
  maxDepth: 3,
  maxPageSizeKB: 2048,
  ecoMode: true,
  followFeeds: true,
  followSitemaps: true,
  recrawlEnabled: true,
};
