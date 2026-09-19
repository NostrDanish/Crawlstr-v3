// Main crawler engine — orchestrates the crawl loop.
//
// Crawlstr is a SCOUT, not a heavy indexer: human-directed and random
// discovery, micro-crawls with explicit budgets, feed/sitemap reading for
// cheap discovery, and SIP-01 publishing. Indexstr owns systematic
// large-scale crawling; this engine stays lightweight on purpose.

import { fetchPage, fetchXml } from './fetcher';
import { parsePage } from './parser';
import { parseFeed, looksLikeFeed, looksLikeSitemap } from './feed';
import { parseSitemap, sampleUrls } from './sitemap';
import { normalizeIndexUrl } from './webIndex';
import { hashContent } from './hasher';
import { shouldCrawlUrl, getCrawlDelay, getSitemaps } from './robots';
import { isPubliclyFetchable } from './safety';
import { canMakeRequest } from './limits';
import { publishIndexObservation, publishHeartbeatEvent, flushObservationOutbox } from './publisher';
import { buildHeartbeat, HEARTBEAT_INTERVAL_MS } from './heartbeat';
import { pickRandomSeed, previewRandomSeed, commitSeed } from './seeds';
import { bytesLastHour, pagesLastHour, recordPage, remainingBytesThisHour } from './meter';
import {
  initDB,
  addToQueue,
  getNextJob,
  removeFromQueue,
  getQueueSize,
  getCrawled,
  isFetched,
  markCrawled,
  findByHash,
  getCrawledCount,
  getRecentCrawled,
  clearQueue,
  getOutboxSize,
} from './queue';
import {
  CRAWL_MODES,
  DEFAULT_SETTINGS,
  type CrawlMode,
  type CrawlerStats,
  type CrawlerSettings,
  type CrawlJob,
} from './types';

/** What one scouting session accomplished — for the completion summary. */
export interface SessionSummary {
  seed: string | null;
  pages: number;
  discovered: number;
  feeds: number;
  sitemaps: number;
}

/**
 * Map well-known hosts to SIP-01 §9.2 `platform` extension values.
 * Deliberately small — an unrecognised host simply gets no platform tag.
 */
function detectPlatform(host: string): string | undefined {
  const h = host.toLowerCase();
  if (h === 'github.com' || h.endsWith('.github.com') || h.endsWith('.github.io')) return 'github';
  if (h === 'gitlab.com' || h.endsWith('.gitlab.com')) return 'gitlab';
  if (h === 'youtube.com' || h === 'youtu.be' || h.endsWith('.youtube.com')) return 'youtube';
  if (h === 'wikipedia.org' || h.endsWith('.wikipedia.org')) return 'wikipedia';
  if (h === 'medium.com' || h.endsWith('.medium.com')) return 'medium';
  if (h === 'dev.to') return 'devto';
  if (h === 'news.ycombinator.com') return 'hackernews';
  if (h.endsWith('.reddit.com') || h === 'reddit.com') return 'reddit';
  if (h === 'stackoverflow.com' || h.endsWith('.stackexchange.com')) return 'stackoverflow';
  return undefined;
}

export class CrawlerEngine {
  private running = false;
  private startTime = 0;
  private settings: CrawlerSettings;
  private stats: CrawlerStats = {
    pagesIndexed: 0,
    queueSize: 0,
    bandwidthUsed: 0,
    uptime: 0,
    errors: 0,
    skipped: 0,
    viaProxy: 0,
    viaDirect: 0,
    robotsBlocked: 0,
    fetchFailed: 0,
    duplicates: 0,
    thinContent: 0,
    urlsDiscovered: 0,
    feedsFound: 0,
    sitemapsFound: 0,
    outboxPending: 0,
  };
  private abortController: AbortController | null = null;
  private onStatsChange?: (stats: CrawlerStats) => void;
  private onModeChange?: (mode: CrawlMode) => void;
  private onSessionEnd?: (summary: SessionSummary) => void;

  /** Active crawl mode — drives the session page budget. */
  private mode: CrawlMode = 'site';
  /** Pages crawled in the current session (reset on start). */
  private sessionPages = 0;
  /** Session-scoped counters for the "SCOUT COMPLETE" summary. */
  private session = { pages: 0, discovered: 0, feeds: 0, sitemaps: 0 };
  /** Random Explorer: when the session budget is spent, pick a fresh seed. */
  private explorer = false;
  /** The seed the current random scout started from (for display). */
  private currentSeed: string | null = null;
  /** Sitemaps already probed this run, so we don't refetch per page. */
  private probedSitemaps = new Set<string>();
  /** Feeds already followed this run. */
  private followedFeeds = new Set<string>();
  /** Heartbeat timer — a running node announces itself every 10 minutes. */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Outbox flush timer — held observations retry every 5 minutes. */
  private outboxTimer: ReturnType<typeof setInterval> | null = null;
  /** Flushes the outbox the moment connectivity returns. */
  private onlineHandler: (() => void) | null = null;

  constructor(settings?: Partial<CrawlerSettings>) {
    const stored = localStorage.getItem('crawler-settings');
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(stored ? JSON.parse(stored) : {}),
      ...settings,
    };
  }

  async init(): Promise<void> {
    await initDB();
    this.stats.queueSize = await getQueueSize();
    this.stats.pagesIndexed = await getCrawledCount();
    this.stats.outboxPending = await getOutboxSize();
  }

  onStats(callback: (stats: CrawlerStats) => void): void {
    this.onStatsChange = callback;
  }

  onMode(callback: (mode: CrawlMode) => void): void {
    this.onModeChange = callback;
  }

  /** Called when a session budget is spent and the crawler stops itself. */
  onSessionComplete(callback: (summary: SessionSummary) => void): void {
    this.onSessionEnd = callback;
  }

  /** Session-scoped counters (reset on every start). */
  getSession(): SessionSummary {
    return {
      seed: this.currentSeed,
      pages: this.session.pages,
      discovered: this.session.discovered,
      feeds: this.session.feeds,
      sitemaps: this.session.sitemaps,
    };
  }

  private emitStats(): void {
    this.stats.uptime = this.running ? Math.floor((Date.now() - this.startTime) / 1000) : 0;
    this.onStatsChange?.({ ...this.stats });
  }

  async start(mode?: CrawlMode): Promise<void> {
    if (this.running) return;
    if (mode) {
      this.mode = mode;
      this.onModeChange?.(mode);
    }
    this.running = true;
    this.startTime = Date.now();
    this.sessionPages = 0;
    this.session = { pages: 0, discovered: 0, feeds: 0, sitemaps: 0 };
    this.abortController = new AbortController();
    this.emitStats();
    this.startHeartbeats();
    this.startOutboxFlush();
    this.crawlLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.explorer = false;
    this.stopHeartbeats();
    this.stopOutboxFlush();
    this.abortController?.abort();
    this.emitStats();
  }

  isRunning(): boolean {
    return this.running;
  }

  getMode(): CrawlMode {
    return this.mode;
  }

  /** Set the crawl mode without starting (takes effect on next start). */
  setMode(mode: CrawlMode): void {
    this.mode = mode;
    this.onModeChange?.(mode);
  }

  isExplorer(): boolean {
    return this.explorer;
  }

  getCurrentSeed(): string | null {
    return this.currentSeed;
  }

  getStats(): CrawlerStats {
    return { ...this.stats };
  }

  getSettings(): CrawlerSettings {
    return { ...this.settings };
  }

  updateSettings(settings: Partial<CrawlerSettings>): void {
    this.settings = { ...this.settings, ...settings };
    localStorage.setItem('crawler-settings', JSON.stringify(this.settings));
  }

  /**
   * Queue admission gate (audit finding #1): a URL that isn't publicly
   * fetchable never enters the queue at all, so robots.txt, feeds, sitemaps
   * and page fetches can never be aimed at loopback/RFC1918/link-local
   * targets — directly or through the CORS proxy. fetchPage() has its own
   * guard; this one makes sure the SSRF surface stays closed even on the
   * fetch paths that run BEFORE it (robots.ts) or bypass it.
   */
  private async enqueue(job: CrawlJob): Promise<boolean> {
    if (!isPubliclyFetchable(job.url)) {
      console.debug('[Crawler] Refused non-public URL at queue admission:', job.url);
      return false;
    }
    await addToQueue(job);
    return true;
  }

  async seedUrl(url: string, priority = 1.0): Promise<void> {
    const normalizedUrl = normalizeIndexUrl(url);
    if (!normalizedUrl) return;
    if (!isPubliclyFetchable(normalizedUrl)) {
      console.debug('[Crawler] Refused non-public seed URL:', normalizedUrl);
      return;
    }
    this.currentSeed = normalizedUrl;
    await addToQueue({
      url: normalizedUrl,
      priority,
      depth: 0,
      attempts: 0,
    });
    this.stats.queueSize = await getQueueSize();
    this.emitStats();
  }

  /**
   * Random Scout: pick a seed from the curated collection (weighted toward
   * fresh/rare/under-explored corners) and start a crawl in the current mode.
   * Returns the chosen seed URL.
   */
  async scoutRandom(mode?: CrawlMode): Promise<string | null> {
    const seed = pickRandomSeed();
    if (!seed) return null;
    await this.seedUrl(seed);
    await this.start(mode);
    return seed;
  }

  /**
   * Preview the next random seed WITHOUT recording it — lets the UI show
   * "🎲 Random corner: https://…" before the user commits. Pair with
   * startScout(url) when they accept.
   */
  previewSeed(categoryId?: string): { url: string; category: string } | null {
    return previewRandomSeed(categoryId);
  }

  /**
   * Start scouting a specific seed (usually one from previewSeed).
   * Commits the selection to local history only now — a dismissed preview
   * never counted against the seed.
   */
  async startScout(url: string, mode?: CrawlMode): Promise<void> {
    commitSeed(url);
    await this.seedUrl(url);
    await this.start(mode);
  }

  /**
   * Random Explorer: continuous scouting. When the session budget is spent,
   * a fresh random seed is picked automatically. Stays subject to every
   * resource limit — this is opt-in volunteer mode, never the default.
   */
  async startExplorer(): Promise<string | null> {
    this.explorer = true;
    const seed = pickRandomSeed();
    if (!seed) return null;
    await this.seedUrl(seed);
    await this.start();
    return seed;
  }

  async clearAll(): Promise<void> {
    await clearQueue();
    this.stats.queueSize = 0;
    this.emitStats();
  }

  async getRecentCrawls(limit = 20) {
    return getRecentCrawled(limit);
  }

  /**
   * The crawl loop is SERIAL BY DESIGN: one job at a time, with politeness
   * sleeps between fetches. There is deliberately no concurrency knob — the
   * old `maxConcurrent` setting was never wired to anything and was removed
   * (audit finding #4) rather than left as a control that silently does
   * nothing. Per-domain pacing lives in limits.ts + the crawlDelay sleep.
   */
  private async crawlLoop(): Promise<void> {
    while (this.running) {
      try {
        if (!(await this.canCrawl())) {
          await this.sleep(10000);
          continue;
        }

        const job = await getNextJob();
        if (!job) {
          // Queue empty. Explorer picks a fresh random seed; otherwise stop
          // when the session budget was the goal and there's nothing left.
          if (this.explorer) {
            const seed = pickRandomSeed();
            if (seed) {
              this.sessionPages = 0;
              this.session = { pages: 0, discovered: 0, feeds: 0, sitemaps: 0 };
              this.probedSitemaps.clear();
              this.followedFeeds.clear();
              await this.seedUrl(seed);
              continue;
            }
          }
          await this.sleep(5000);
          continue;
        }

        if (!(await canMakeRequest(job.url))) {
          job.nextAttempt = Date.now() + 10000;
          await addToQueue(job);
          await this.sleep(5000);
          continue;
        }

        await this.crawlUrl(job);
        this.emitStats();

        // Session budget — the crawl modes.
        const maxPages = CRAWL_MODES[this.mode].maxPages;
        if (maxPages > 0 && this.sessionPages >= maxPages) {
          if (this.explorer) {
            const seed = pickRandomSeed();
            if (seed) {
              this.sessionPages = 0;
              this.session = { pages: 0, discovered: 0, feeds: 0, sitemaps: 0 };
              this.probedSitemaps.clear();
              this.followedFeeds.clear();
              await this.seedUrl(seed);
            } else {
              this.onSessionEnd?.(this.getSession());
              await this.stop();
              return;
            }
          } else {
            this.onSessionEnd?.(this.getSession());
            await this.stop();
            return;
          }
        }

        const crawlDelay = this.settings.respectRobots ? await getCrawlDelay(job.url) : 0;
        await this.sleep(Math.max(crawlDelay, this.settings.ecoMode ? 8000 : 3000));
      } catch (error) {
        console.error('[Crawler] Loop error:', error);
        this.stats.errors++;
        this.emitStats();
        await this.sleep(10000);
      }
    }
  }

  private async crawlUrl(job: CrawlJob): Promise<void> {
    // Belt-and-braces SSRF guard for jobs already in the queue (e.g. queued
    // before the admission gate existed): never run robots.txt or a page
    // fetch against a non-public target.
    if (!isPubliclyFetchable(job.url)) {
      console.debug('[Crawler] Dropped non-public queued URL:', job.url);
      await removeFromQueue(job.url);
      this.stats.skipped++;
      return;
    }

    // Check if already crawled — but only skip when we ACTUALLY fetched it.
    // Feed/sitemap-derived 'observed' entries must not block a real fetch
    // (a feed can announce a page that fails when actually downloaded).
    if (await isFetched(job.url)) {
      await removeFromQueue(job.url);
      this.stats.skipped++;
      return;
    }

    // Check robots.txt
    if (this.settings.respectRobots) {
      const allowed = await shouldCrawlUrl(job.url);
      if (!allowed) {
        console.debug('[Crawler] Blocked by robots.txt:', job.url);
        await removeFromQueue(job.url);
        this.stats.skipped++;
        this.stats.robotsBlocked++;
        return;
      }
    }

    // Fetch page. Clamp the size cap to the remaining hourly bandwidth so a
    // single page can't blow the budget — the audit's overshoot finding.
    const bandwidthLimitBytes = this.settings.maxBandwidthMB * 1024 * 1024;
    const remainingKB = Math.floor(remainingBytesThisHour(bandwidthLimitBytes) / 1024);
    const effectiveMaxKB = Math.max(0, Math.min(this.settings.maxPageSizeKB, remainingKB));
    if (effectiveMaxKB < 16) {
      // Not enough budget left for a meaningful page — idle until the window opens.
      return;
    }
    const result = await fetchPage(job.url, effectiveMaxKB);
    if (!result) {
      this.stats.errors++;
      this.stats.fetchFailed++;
      job.attempts++;
      if (job.attempts >= 3) {
        await removeFromQueue(job.url);
      } else {
        job.nextAttempt = Date.now() + Math.pow(2, job.attempts) * 60000;
        await addToQueue(job);
      }
      return;
    }

    // Parse content
    const parsed = parsePage(result.html, job.url);

    // Skip pages with very little content
    if (parsed.wordCount < 10) {
      await removeFromQueue(job.url);
      this.stats.skipped++;
      this.stats.thinContent++;
      return;
    }

    // Hash content for local dedup
    const localHash = await hashContent(parsed.text);

    // Check for duplicate content locally
    const duplicate = await findByHash(localHash);
    if (duplicate) {
      await removeFromQueue(job.url);
      this.stats.skipped++;
      this.stats.duplicates++;
      return;
    }

    // Mark as crawled locally
    await markCrawled(job.url, localHash, parsed.title);
    await removeFromQueue(job.url);

    // Update stats
    this.stats.pagesIndexed++;
    this.sessionPages++;
    this.session.pages++;
    recordPage(); // pages/hour budget window
    this.stats.bandwidthUsed += result.size;
    if (result.viaProxy) this.stats.viaProxy++;
    else this.stats.viaDirect++;
    this.stats.queueSize = await getQueueSize();

    // Publish SIP-01 v1.1 observation to the shared index (kind 39697).
    // Canonical spec: https://github.com/NostrDanish/SIP-01
    //
    // If the page claims a canonical URL, the observation is filed under
    // THAT identity (§7 normalization keeps it byte-compatible with every
    // other indexer).
    const indexUrl = parsed.canonical
      ? (normalizeIndexUrl(parsed.canonical) ?? job.url)
      : job.url;
    const host = new URL(indexUrl).hostname;
    const platform = detectPlatform(host);
    const published = await publishIndexObservation({
      url: indexUrl,
      title: parsed.title,
      description: parsed.description,
      image: parsed.image,
      language: parsed.language,
      published: parsed.published,
      tags: parsed.keywords,
      source: 'crawlstr/1',
      // Extension registry (spec §9.2): a browser crawler only ever sees clearnet.
      network: 'clearnet',
      ...(platform ? { platform } : {}),
      type: platform === 'github' || platform === 'gitlab' ? 'repository' : 'page',
    });
    await this.notePublishResult(published?.delivered);

    // --- Discovery: feeds -------------------------------------------------
    if (this.settings.followFeeds && parsed.feeds.length > 0) {
      for (const feed of parsed.feeds.slice(0, 2)) {
        if (this.followedFeeds.has(feed.url)) continue;
        this.followedFeeds.add(feed.url);
        await this.followFeed(feed.url, job);
      }
    }

    // --- Discovery: sitemap ----------------------------------------------
    if (this.settings.followSitemaps) {
      const origin = new URL(job.url).origin;
      if (!this.probedSitemaps.has(origin)) {
        this.probedSitemaps.add(origin);
        await this.probeSitemaps(origin, job);
      }
    }

    // --- Discovery: links -------------------------------------------------
    if (job.depth < this.settings.maxDepth) {
      const maxLinks = this.settings.ecoMode ? 5 : 10;
      let added = 0;
      for (const link of parsed.links.slice(0, maxLinks)) {
        const normalized = normalizeIndexUrl(link);
        if (!normalized) continue;

        // Don't re-crawl same URL
        if (normalized === job.url) continue;

        // Skip obvious non-content: login/auth/cart/wallet traps.
        if (this.looksLikeTrap(normalized)) continue;

        const enqueued = await this.enqueue({
          url: normalized,
          priority: job.priority * 0.8,
          depth: job.depth + 1,
          discoveredFrom: job.url,
          attempts: 0,
        });
        if (enqueued) added++;
      }
      if (added > 0) {
        this.stats.urlsDiscovered += added;
        this.session.discovered += added;
        this.stats.queueSize = await getQueueSize();
      }
    }
  }

  /**
   * Fetch a discovered feed and index its entries as observations.
   * A feed is the cheapest source of canonical content URLs on the web —
   * one small XML file yields a list of current pages with titles and dates.
   */
  private async followFeed(feedUrl: string, fromJob: CrawlJob): Promise<void> {
    const xml = await fetchXml(feedUrl);
    if (!xml || !looksLikeFeed(xml)) return;

    const feed = parseFeed(xml, feedUrl, this.settings.ecoMode ? 5 : 10);
    if (!feed || feed.entries.length === 0) return;

    this.stats.feedsFound++;
    this.session.feeds++;
    let discovered = 0;

    for (const entry of feed.entries) {
      const normalized = normalizeIndexUrl(entry.url);
      if (!normalized) continue;

      // Skip entries we've already observed.
      const existing = await getCrawled(normalized);
      if (existing) continue;

      // Index the entry directly — the feed itself is the site's own summary.
      // Mark as 'observed', NOT 'fetched': we read the feed's claim about the
      // page, we didn't fetch the page. The queue entry below still schedules
      // a real fetch, and observed≠fetched means that fetch won't be skipped.
      if (entry.title && entry.title !== normalized) {
        await markCrawled(normalized, await hashContent(entry.title), entry.title, 'observed');
        const host = new URL(normalized).hostname;
        const platform = detectPlatform(host);
        const publishedObservation = await publishIndexObservation({
          url: normalized,
          title: entry.title,
          description: entry.summary,
          language: undefined,
          published: entry.published,
          source: 'crawlstr/1',
          network: 'clearnet',
          ...(platform ? { platform } : {}),
          type: 'article',
        });
        await this.notePublishResult(publishedObservation?.delivered);
        this.stats.pagesIndexed++;
      }

      // And queue it for a real page fetch at lower priority.
      const enqueued = await this.enqueue({
        url: normalized,
        priority: fromJob.priority * 0.6,
        depth: fromJob.depth + 1,
        discoveredFrom: feedUrl,
        attempts: 0,
      });
      if (enqueued) discovered++;
    }

    this.stats.urlsDiscovered += discovered;
    this.session.discovered += discovered;
    this.stats.queueSize = await getQueueSize();
    console.debug(`[Crawler] Feed discovered: ${feedUrl} (${feed.entries.length} entries)`);
  }

  /**
   * Probe a domain for sitemaps: robots.txt Sitemap: declarations first,
   * then the conventional /sitemap.xml. Sampled and bounded — we read the
   * map, we don't drink from it.
   */
  private async probeSitemaps(origin: string, fromJob: CrawlJob): Promise<void> {
    const candidates = await getSitemaps(origin + '/');
    const fallback = `${origin}/sitemap.xml`;
    if (candidates.length === 0) candidates.push(fallback);

    for (const sitemapUrl of candidates.slice(0, 2)) {
      const xml = await fetchXml(sitemapUrl);
      if (!xml || !looksLikeSitemap(xml)) continue;

      const sitemap = parseSitemap(xml, sitemapUrl);
      if (!sitemap) continue;

      this.stats.sitemapsFound++;
      this.session.sitemaps++;
      console.debug(`[Crawler] Sitemap discovered: ${sitemapUrl} (${sitemap.urls.length} URLs, ${sitemap.sitemaps.length} children)`);

      // Sample page URLs — a sitemap can hold tens of thousands.
      const sample = sampleUrls(sitemap.urls, this.settings.ecoMode ? 10 : 25);
      let added = 0;
      for (const url of sample) {
        const normalized = normalizeIndexUrl(url);
        if (!normalized) continue;
        // Only skip URLs we ACTUALLY fetched — observed ones still get a real fetch.
        if (await isFetched(normalized)) continue;
        if (this.looksLikeTrap(normalized)) continue;

        const enqueued = await this.enqueue({
          url: normalized,
          priority: fromJob.priority * 0.5,
          depth: fromJob.depth + 1,
          discoveredFrom: sitemapUrl,
          attempts: 0,
        });
        if (enqueued) added++;
      }

      // Sitemap index: follow ONE child sitemap for a taste of what's inside.
      if (sitemap.sitemaps.length > 0 && sitemap.urls.length === 0) {
        const child = sitemap.sitemaps[Math.floor(Math.random() * sitemap.sitemaps.length)];
        const childXml = await fetchXml(child);
        if (childXml && looksLikeSitemap(childXml)) {
          const childSitemap = parseSitemap(childXml, child);
          if (childSitemap) {
            const childSample = sampleUrls(childSitemap.urls, this.settings.ecoMode ? 10 : 25);
            for (const url of childSample) {
              const normalized = normalizeIndexUrl(url);
              if (!normalized || this.looksLikeTrap(normalized)) continue;
              if (await isFetched(normalized)) continue;
              const enqueued = await this.enqueue({
                url: normalized,
                priority: fromJob.priority * 0.5,
                depth: fromJob.depth + 1,
                discoveredFrom: child,
                attempts: 0,
              });
              if (enqueued) added++;
            }
          }
        }
      }

      if (added > 0) {
        this.stats.urlsDiscovered += added;
        this.session.discovered += added;
        this.stats.queueSize = await getQueueSize();
      }
    }
  }

  /**
   * Cheap trap detection — URLs that are never content and would waste the
   * crawl budget or worse (login flows, carts, calendars, trackers).
   */
  private looksLikeTrap(url: string): boolean {
    try {
      const u = new URL(url);
      const path = u.pathname.toLowerCase();
      if (/\/(login|logout|signin|signout|signup|register|auth|account|cart|checkout|basket|wallet|password|reset)\b/.test(path)) return true;
      if (path.includes('/wp-admin') || path.includes('/wp-login')) return true;
      if (/\d{4}\/\d{2}\/\d{2}/.test(path) && u.searchParams.has('page')) return true; // calendar paging
      if (path.endsWith('.zip') || path.endsWith('.exe') || path.endsWith('.dmg') || path.endsWith('.tar.gz')) return true;
      return false;
    } catch {
      return true;
    }
  }

  /**
   * Node heartbeat (kind 16919, replaceable) — published on start and every
   * 10 minutes while running. This is how the SIP-01 dashboard sees the
   * scout network: who's alive, what shard, coarse platform/network class,
   * self-reported counters.
   *
   * Self-reported health metadata only — never a reputation input, and
   * coarse by design (no location, no IP, no device fingerprint).
   */
  private startHeartbeats(): void {
    this.stopHeartbeats();
    this.publishHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.publishHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeats(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Observation outbox (audit finding #3 / contract C-2): events that got
   * zero relay accepts are held in IndexedDB and flushed at crawl start, on
   * the browser's `online` event, and every 5 minutes while running. A dead
   * network no longer silently costs observations.
   */
  private startOutboxFlush(): void {
    this.stopOutboxFlush();
    void this.flushOutbox();
    this.outboxTimer = setInterval(() => void this.flushOutbox(), 5 * 60 * 1000);
    this.onlineHandler = () => void this.flushOutbox();
    window.addEventListener('online', this.onlineHandler);
  }

  private stopOutboxFlush(): void {
    if (this.outboxTimer) {
      clearInterval(this.outboxTimer);
      this.outboxTimer = null;
    }
    if (this.onlineHandler) {
      window.removeEventListener('online', this.onlineHandler);
      this.onlineHandler = null;
    }
  }

  private async flushOutbox(): Promise<void> {
    try {
      const delivered = await flushObservationOutbox();
      if (delivered > 0) {
        console.debug(`[Crawler] Outbox flushed ${delivered} held observation(s)`);
      }
      this.stats.outboxPending = await getOutboxSize();
      this.emitStats();
    } catch (error) {
      // Flushing is best-effort; the outbox keeps the events for next time.
      console.debug('[Crawler] Outbox flush failed:', error);
    }
  }

  /** Reflect a possibly-enqueued observation in stats immediately. */
  private async notePublishResult(delivered: number | undefined): Promise<void> {
    if (delivered === 0) {
      this.stats.outboxPending = await getOutboxSize();
    }
  }

  private async publishHeartbeat(): Promise<void> {
    try {
      const event = await buildHeartbeat({
        pagesIndexed: this.stats.pagesIndexed,
        queueSize: this.stats.queueSize,
        published: this.stats.pagesIndexed, // pages indexed ≈ observations published
      });
      await publishHeartbeatEvent(event);
    } catch (error) {
      // Heartbeats are best-effort; a missed beat just reads as offline.
      console.debug('[Crawler] Heartbeat failed:', error);
    }
  }

  private async canCrawl(): Promise<boolean> {
    // Check battery
    if ('getBattery' in navigator) {
      try {
        const battery = await (navigator as unknown as { getBattery(): Promise<{ level: number; charging: boolean }> }).getBattery();
        if (battery.level < 0.15 && !battery.charging) {
          return false;
        }
        if (this.settings.chargingOnly && !battery.charging) {
          return false;
        }
      } catch {
        // Battery API not available, continue
      }
    }

    // Check network
    if ('connection' in navigator) {
      const conn = (navigator as unknown as { connection?: { effectiveType?: string; type?: string } }).connection;
      if (conn?.effectiveType === 'slow-2g' || conn?.effectiveType === '2g') {
        return false;
      }
      if (this.settings.wifiOnly && conn?.type !== 'wifi' && conn?.effectiveType !== '4g') {
        return false;
      }
    }

    // --- Resource budgets (the audit's #1 finding) ---
    // Bandwidth: meter.ts counts EVERY byte — pages, robots.txt, feeds,
    // sitemaps, proxy overhead — not just successfully parsed pages.
    // Gate on the minimum meaningful page size so crawlUrl never busy-loops
    // on a budget too small to fetch with.
    const bandwidthLimitBytes = this.settings.maxBandwidthMB * 1024 * 1024;
    if (bytesLastHour() + 16 * 1024 > bandwidthLimitBytes) {
      return false;
    }

    // Pages/hour: previously advertised in settings but never enforced.
    if (pagesLastHour() >= this.settings.maxPagesPerHour) {
      return false;
    }

    return true;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timeout = setTimeout(resolve, ms);
      this.abortController?.signal.addEventListener('abort', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}
