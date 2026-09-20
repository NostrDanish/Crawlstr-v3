// Main crawler engine — orchestrates the crawl loop (v2).
//
// Crawlstr is a SCOUT, not a heavy indexer: human-directed and random
// discovery, micro-crawls with explicit budgets, feed/sitemap reading for
// cheap discovery, and SIP-01 publishing. Indexstr owns systematic
// large-scale crawling; this engine stays lightweight on purpose.
//
// v2 architecture (learned from crawlstr-v2, adapted to this codebase):
//
//   - EVENT-DRIVEN MULTI-SLOT LOOP: `scheduler.slotCount` parallel slot
//     runners over the Scheduler allocator (per-domain seriality, interval
//     pacing, computed sleeps — never busy-polls). v1 was one serial loop
//     with fixed sleeps; v2 doubles domain-diversity utilization while
//     keeping ≤1 request in flight per domain and the same per-domain rate.
//   - ORDERING INVARIANT (structural): every enqueue source (seeds,
//     discovered links, feeds, sitemaps) funnels through the admission gate:
//     normalize → SSRF guard → trap guards → queue. Private URLs never
//     enter the queue from anywhere.
//   - FRESHNESS (freshness.ts): crawled URLs get an adaptive recrawl
//     schedule — changed pages return in 24h, unchanged pages double toward
//     30d. v1 never recrawled; the index went stale forever.
//   - NEGATIVE CACHE: permanent fetch failures are remembered for 7 days
//     instead of being retried forever or forgotten and re-fetched.
//   - DISCRIMINATED FETCH OUTCOMES (fetcher.ts): permanent vs transient,
//     transient failures get bounded exponential backoff (backoff.ts).
//   - TRAP GUARDS (traps.ts): session-state URLs, filter generators and
//     infinite path spaces never enter the queue; a per-domain cap stops
//     one host from flooding discovery.
//   - FIRE-AND-TRACK PUBLISH LANE: relay fan-out never blocks the crawl
//     loop; the lane drains on stop. `stats.published` counts only
//     relay-ACKed events.

import { fetchPage, fetchXml } from './fetcher';
import { parsePage } from './parser';
import { parseFeed, looksLikeFeed, looksLikeSitemap } from './feed';
import { parseSitemap, sampleUrls } from './sitemap';
import { normalizeIndexUrl } from './webIndex';
import { hashContent } from './hasher';
import { shouldCrawlUrl, getCrawlDelay, getSitemaps } from './robots';
import { isPubliclyFetchable } from './safety';
import { publishIndexObservation, publishHeartbeatEvent, flushObservationOutbox } from './publisher';
import { buildHeartbeat, HEARTBEAT_INTERVAL_MS } from './heartbeat';
import { pickRandomSeed, previewRandomSeed, commitSeed, pickRandomSeedBundle, SCOUT_BUNDLE_SIZE } from './seeds';
import { bytesLastHour, pagesLastHour, recordPage, remainingBytesThisHour } from './meter';
import { Scheduler } from './scheduler';
import { nextFreshness, type FreshnessState } from './freshness';
import { isLikelyCrawlTrap, DomainIntakeGuard } from './traps';
import { retryBackoffMs, isRetryable } from './backoff';
import {
  initDB,
  addToQueue,
  claimNextJob,
  removeFromQueue,
  isQueued,
  getQueueSize,
  getCrawled,
  isFetched,
  isFailureCached,
  markCrawled,
  markFailed,
  getDueRecrawlUrls,
  maintenanceSweep,
  findByHash,
  getCrawledCount,
  getRecentCrawled,
  clearQueue,
  getOutboxSize,
  type CrawledRecord,
} from './queue';
import {
  CRAWL_MODES,
  DEFAULT_SETTINGS,
  type CrawlMode,
  type CrawlerStats,
  type CrawlerSettings,
  type CrawlJob,
} from './types';

/** Indexer software id for the SIP-01 `source` tag (v2 nodes identify as
 *  `crawlstr/v2` so indexers and stats dashboards can distinguish v1/v2
 *  Crawlstr traffic from Indexstr). */
export const CRAWLER_SOURCE = 'crawlstr/v2';

/** What one scouting session accomplished — for the completion summary. */
export interface SessionSummary {
  seed: string | null;
  pages: number;
  discovered: number;
  feeds: number;
  sitemaps: number;
}

/** A claimed job: either from the queue or an adaptive recrawl. */
type ClaimedJob = CrawlJob & { recrawl?: boolean };

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
    published: 0,
    ssrfBlocked: 0,
    trapsBlocked: 0,
    recrawls: 0,
  };
  private abortController: AbortController | null = null;
  private onStatsChange?: (stats: CrawlerStats) => void;
  private onModeChange?: (mode: CrawlMode) => void;
  private onSessionEnd?: (summary: SessionSummary) => void;

  /** Active crawl mode — v2 simplified UX: the scout runs until stopped.
   *  The mode machinery stays (maxPages budget per session) but the UI no
   *  longer exposes modes; the effective mode is always 'volunteer'. */
  private mode: CrawlMode = 'volunteer';
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
  /** Storage maintenance timer — negative-cache TTL + store cap sweep. */
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  /** Flushes the outbox the moment connectivity returns. */
  private onlineHandler: (() => void) | null = null;

  /** Politeness allocator — rebuilt from settings on every start. */
  private scheduler = new Scheduler({
    minIntervalPerDomainMs: DEFAULT_SETTINGS.ecoMode ? 8000 : 5000,
    maxCrawlDelayMs: 60_000,
    parallelism: 2,
  });
  /** Per-domain cap on discovered URLs (traps.ts) — one host can't flood
   *  the queue through link following. Seeds are exempt (explicit choice). */
  private readonly discoveryGuard = new DomainIntakeGuard(500);
  /** Wake hooks for sleeping slot runners (event-driven dispatch). */
  private readonly wakeListeners = new Set<() => void>();
  /** In-flight publish lane promises — drained on stop. */
  private readonly publishLane = new Set<Promise<void>>();
  /** Recrawl URLs currently claimed by a slot (never double-claimed). */
  private readonly recrawlClaims = new Set<string>();
  /** Explorer seed-pick guard — only one slot picks the next seed. */
  private pickingSeed = false;

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
    await maintenanceSweep();
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
    this.scheduler = new Scheduler({
      minIntervalPerDomainMs: this.settings.ecoMode ? 8000 : 5000,
      maxCrawlDelayMs: 60_000,
      parallelism: 2,
    });
    this.probedSitemaps.clear();
    this.followedFeeds.clear();
    this.pickingSeed = false;
    this.emitStats();
    this.startHeartbeats();
    this.startOutboxFlush();
    this.startMaintenance();

    // Spawn the parallel slot runners. Each loops independently over the
    // scheduler — per-domain seriality makes politeness race-free. The
    // controller is captured per runner so a stale loop from a previous
    // start() generation exits instead of joining the new one.
    const ac = this.abortController as AbortController;
    const slots = this.scheduler.slotCount;
    for (let i = 0; i < slots; i++) {
      void this.slotLoop(ac);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.explorer = false;
    this.stopHeartbeats();
    this.stopOutboxFlush();
    this.stopMaintenance();
    this.abortController?.abort();
    this.wake();
    // Drain the publish lane with a short grace — a hanging relay must not
    // stall shutdown, but delivered-then-exited beats dropped accounting.
    // (Plain timeout, NOT this.sleep — that one resolves instantly on abort.)
    const drain = Promise.allSettled([...this.publishLane]);
    const grace = new Promise<void>((resolve) => setTimeout(resolve, 2_000));
    await Promise.race([drain, grace]);
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
    // The politeness interval is baked into the scheduler at start();
    // changing ecoMode mid-run takes effect on the next start (documented).
  }

  /**
   * Queue admission gate: a URL that isn't publicly fetchable never enters
   * the queue at all, so robots.txt, feeds, sitemaps and page fetches can
   * never be aimed at loopback/RFC1918/link-local targets — directly or
   * through the CORS proxy. Discovered URLs additionally pass the trap
   * guards; seeds are the human's explicit choice and bypass them.
   */
  private async enqueue(job: CrawlJob, discovered: boolean): Promise<boolean> {
    if (!isPubliclyFetchable(job.url)) {
      console.debug('[Crawler] Refused non-public URL at queue admission:', job.url);
      this.stats.ssrfBlocked++;
      return false;
    }
    if (discovered) {
      if (isLikelyCrawlTrap(job.url)) {
        console.debug('[Crawler] Refused crawl-trap URL at admission:', job.url);
        this.stats.trapsBlocked++;
        return false;
      }
      if (!this.discoveryGuard.allow(job.url)) {
        console.debug('[Crawler] Domain discovery cap reached:', job.url);
        return false;
      }
    }
    await addToQueue(job);
    this.wake();
    return true;
  }

  async seedUrl(url: string, priority = 1.0): Promise<void> {
    const normalizedUrl = normalizeIndexUrl(url);
    if (!normalizedUrl) return;
    if (!isPubliclyFetchable(normalizedUrl)) {
      console.debug('[Crawler] Refused non-public seed URL:', normalizedUrl);
      this.stats.ssrfBlocked++;
      this.emitStats();
      return;
    }
    this.currentSeed = normalizedUrl;
    await addToQueue({
      url: normalizedUrl,
      priority,
      depth: 0,
      attempts: 0,
    });
    this.wake();
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
   * Random Scout (v2 simplified UX): ONE control. Picks a bundle of
   * SCOUT_BUNDLE_SIZE distinct curated seeds, queues them all, and starts
   * crawling in explorer mode — when the queue drains, a fresh bundle is
   * picked automatically, so it keeps scouting new corners until stopped.
   * Pressing the button again calls stop(); pressing it once more starts a
   * fresh bundle. Returns the seeds queued.
   */
  async startScoutBundle(): Promise<string[]> {
    const seeds = pickRandomSeedBundle(SCOUT_BUNDLE_SIZE);
    if (seeds.length === 0) return [];
    this.explorer = true;
    for (const seed of seeds) {
      await this.seedUrl(seed);
    }
    this.currentSeed = seeds[0] ?? null;
    await this.start();
    return seeds;
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

  async getRecentCrawls(limit = 20): Promise<CrawledRecord[]> {
    return getRecentCrawled(limit);
  }

  /* ------------------------------------------------------------------ */
  /* Slot loop — event-driven parallel dispatch over the scheduler       */
  /* ------------------------------------------------------------------ */

  private async slotLoop(ac: AbortController): Promise<void> {
    while (this.running && this.abortController === ac) {
      try {
        if (!(await this.canCrawl())) {
          await this.sleep(10_000, ac);
          continue;
        }

        const job = await this.claimJob();
        if (!job) {
          // Queue empty (and no due recrawls). Explorer picks a FRESH BUNDLE
          // of random seeds so scouting continues across corners until the
          // user stops it; everyone else naps until a wake event or the poll
          // timeout.
          if (this.explorer && !this.pickingSeed) {
            this.pickingSeed = true;
            try {
              const seeds = pickRandomSeedBundle(SCOUT_BUNDLE_SIZE);
              if (seeds.length > 0) {
                this.session = { pages: 0, discovered: 0, feeds: 0, sitemaps: 0 };
                this.probedSitemaps.clear();
                this.followedFeeds.clear();
                for (const seed of seeds) {
                  await this.seedUrl(seed);
                }
                this.currentSeed = seeds[0] ?? null;
                continue;
              }
              // Corpus exhausted — nothing left to explore.
              this.onSessionEnd?.(this.getSession());
              await this.stop();
              return;
            } finally {
              this.pickingSeed = false;
            }
          }
          await this.waitForWake(30_000, ac);
          continue;
        }

        // Robots policy (cached per domain; the lookup is same-origin traffic
        // and counts toward the domain's politeness lane).
        const crawlDelay = this.settings.respectRobots ? await getCrawlDelay(job.url) : 0;
        this.scheduler.noteRequest(job.url);

        if (!this.scheduler.tryAcquire(job.url, crawlDelay)) {
          const wait = this.scheduler.timeUntilNextRequest(job.url, crawlDelay);
          job.nextAttempt = Date.now() + wait;
          // The job returns to the queue — release the recrawl claim so a
          // future due-scan can consider it again if the queue drains.
          if (job.recrawl) this.recrawlClaims.delete(job.url);
          await addToQueue(job);
          await this.waitForWake(Math.min(Math.max(wait, 1_000), 30_000), ac);
          continue;
        }

        try {
          await this.crawlUrl(job);
        } finally {
          this.scheduler.release(job.url);
          if (job.recrawl) this.recrawlClaims.delete(job.url);
        }
        this.emitStats();

        // Session budget — the crawl modes.
        const maxPages = CRAWL_MODES[this.mode].maxPages;
        if (maxPages > 0 && this.sessionPages >= maxPages && !this.explorer) {
          this.onSessionEnd?.(this.getSession());
          await this.stop();
          return;
        }
      } catch (error) {
        console.error('[Crawler] Loop error:', error);
        this.stats.errors++;
        this.emitStats();
        await this.sleep(10_000, ac);
      }
    }
  }

  /**
   * Claim the next unit of work: a ready queue job first, else an adaptive
   * recrawl that has come due (freshness.ts). Returns null when there is
   * nothing to do right now.
   */
  private async claimJob(): Promise<ClaimedJob | null> {
    const job = await claimNextJob();
    if (job) return job;

    if (!this.settings.recrawlEnabled) return null;

    const due = await getDueRecrawlUrls(10, this.recrawlClaims, Date.now());
    for (const url of due) {
      if (await isQueued(url)) continue;
      this.recrawlClaims.add(url);
      return {
        url,
        priority: 0.5,
        depth: 0,
        attempts: 0,
        discoveredFrom: 'recrawl',
        recrawl: true,
      };
    }
    return null;
  }

  private async crawlUrl(job: ClaimedJob): Promise<void> {
    // 1. Belt-and-braces SSRF guard for jobs already in the queue (e.g.
    //    queued before the admission gate existed): never run robots.txt or
    //    a page fetch against a non-public target.
    if (!isPubliclyFetchable(job.url)) {
      console.debug('[Crawler] Dropped non-public queued URL:', job.url);
      await removeFromQueue(job.url);
      this.stats.skipped++;
      this.stats.ssrfBlocked++;
      return;
    }

    const existing = await getCrawled(job.url);
    // Narrowed non-undefined view when the URL was actually fetched before.
    const existingFetched =
      existing && existing.status === 'fetched' ? existing : undefined;

    // 2. Negative cache — a permanent failure still inside its TTL is not
    //    worth another request.
    if (existing?.status === 'failed' && (await isFailureCached(job.url))) {
      await removeFromQueue(job.url);
      this.stats.skipped++;
      return;
    }

    // 3. Freshness gate — already fetched and not due for recrawl: drop.
    //    (Recrawl jobs claimed by claimJob are due by construction.)
    //    Records written before v2 have no recrawlDue — treat them as due
    //    24h after their last crawl so the post-upgrade recrawl wave is
    //    staggered instead of bursting everything at once.
    const isRecrawl = existingFetched !== undefined;
    if (existingFetched) {
      const DAY_MS = 24 * 3_600_000;
      const dueAt =
        existingFetched.recrawlDue !== undefined
          ? existingFetched.recrawlDue
          : existingFetched.crawledAt + DAY_MS;
      if (!this.settings.recrawlEnabled || dueAt > Date.now()) {
        await removeFromQueue(job.url);
        this.stats.skipped++;
        return;
      }
    }

    // 4. robots.txt
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

    // 5. Fetch page. Clamp the size cap to the remaining hourly bandwidth so
    //    a single page can't blow the budget. Not enough budget → requeue
    //    for later (the claimed job must not vanish).
    const bandwidthLimitBytes = this.settings.maxBandwidthMB * 1024 * 1024;
    const remainingKB = Math.floor(remainingBytesThisHour(bandwidthLimitBytes) / 1024);
    const effectiveMaxKB = Math.max(0, Math.min(this.settings.maxPageSizeKB, remainingKB));
    if (effectiveMaxKB < 16) {
      job.nextAttempt = Date.now() + 5 * 60_000;
      // The job returns to the queue — release any recrawl claim.
      if (job.recrawl) this.recrawlClaims.delete(job.url);
      await addToQueue(job);
      return;
    }

    const outcome = await fetchPage(job.url, { maxSizeKB: effectiveMaxKB });
    if (!outcome.ok) {
      const failure = outcome.failure;
      if (failure.kind === 'permanent') {
        // 4xx, non-HTML, oversize, SSRF redirect: never worth retrying —
        // remember the failure so discovery doesn't re-fetch it tomorrow.
        await markFailed(job.url);
        await removeFromQueue(job.url);
        this.stats.fetchFailed++;
        if (failure.reason === 'ssrf') this.stats.ssrfBlocked++;
      } else {
        // Transient: bounded exponential backoff (backoff.ts).
        job.attempts++;
        if (isRetryable(job.attempts)) {
          job.nextAttempt = Date.now() + retryBackoffMs(job.attempts);
          await addToQueue(job);
        } else {
          await markFailed(job.url);
          await removeFromQueue(job.url);
          this.stats.fetchFailed++;
        }
      }
      return;
    }
    const result = outcome.page;

    // 6. Parse content
    const parsed = parsePage(result.html, job.url);

    // 7. Thin content — permanent skip (JS-rendered SPAs have no static text).
    if (parsed.wordCount < 10) {
      await markFailed(job.url);
      await removeFromQueue(job.url);
      this.stats.skipped++;
      this.stats.thinContent++;
      return;
    }

    // 8. Hash content; change detection against the stored record.
    const localHash = await hashContent(parsed.text);
    const changed = existingFetched
      ? existingFetched.contentHash !== localHash
      : true;

    // 9. Cross-page duplicate content. v1 dropped the URL entirely (no local
    //    record — the next discovery re-fetched it). v2 records it so we
    //    never re-fetch, and still publishes: the observation's `d` is the
    //    URL identity, and matching `x` hashes are exactly the agreement
    //    signal spec §8 is for.
    if (!isRecrawl) {
      const duplicate = await findByHash(localHash);
      if (duplicate && duplicate !== job.url) {
        this.stats.duplicates++;
      }
    }

    // 10. Mark as crawled locally + adaptive freshness schedule.
    const freshness = nextFreshness(
      existingFetched
        ? ({
            changeCount: existingFetched.changeCount,
            unchangedStreak: existingFetched.unchangedStreak,
            lastChangedAt: existingFetched.lastChangedAt,
          } satisfies FreshnessState)
        : undefined,
      changed,
      Date.now(),
    );
    await markCrawled(job.url, localHash, parsed.title, 'fetched', freshness);
    await removeFromQueue(job.url);

    // 11. Stats
    this.stats.pagesIndexed++;
    this.sessionPages++;
    this.session.pages++;
    if (isRecrawl) this.stats.recrawls++;
    recordPage(); // pages/hour budget window
    this.stats.bandwidthUsed += result.size;
    if (result.viaProxy) this.stats.viaProxy++;
    else this.stats.viaDirect++;
    this.stats.queueSize = await getQueueSize();

    // 12. Publish SIP-01 observation (kind 39697) — fire-and-track: relay
    //     fan-out must never stall the crawl loop. If the page claims a
    //     canonical URL, the observation is filed under THAT identity
    //     (§7 normalization keeps it byte-compatible with every indexer).
    const indexUrl = parsed.canonical
      ? (normalizeIndexUrl(parsed.canonical) ?? job.url)
      : job.url;
    const host = new URL(indexUrl).hostname;
    const platform = detectPlatform(host);
    const publishPromise = publishIndexObservation({
      url: indexUrl,
      title: parsed.title,
      description: parsed.description,
      image: parsed.image,
      language: parsed.language,
      published: parsed.published,
      tags: parsed.keywords,
      source: CRAWLER_SOURCE,
      // Extension registry (spec §9.2): a browser crawler only ever sees clearnet.
      network: 'clearnet',
      ...(platform ? { platform } : {}),
      type: platform === 'github' || platform === 'gitlab' ? 'repository' : 'page',
    })
      .then((published) => {
        // Acked-only accounting: count events at least one relay accepted.
        if (published && published.delivered > 0) {
          this.stats.published++;
        } else {
          this.notePublishResult(published?.delivered);
        }
        this.emitStats();
      })
      .catch((error) => {
        console.debug('[Crawler] Observation publish failed:', error);
      });
    this.trackPublish(publishPromise);

    // --- Discovery: feeds -------------------------------------------------
    if (this.settings.followFeeds && parsed.feeds.length > 0) {
      for (const feed of parsed.feeds.slice(0, 2)) {
        if (this.followedFeeds.has(feed.url)) continue;
        this.followedFeeds.add(feed.url);
        await this.followFeed(feed.url, job);
      }
    }

    // --- Discovery: sitemaps ----------------------------------------------
    if (this.settings.followSitemaps) {
      const origin = new URL(job.url).origin;
      if (!this.probedSitemaps.has(origin)) {
        this.probedSitemaps.add(origin);
        await this.probeSitemaps(origin, job);
      }
    }

    // --- Discovery: links -------------------------------------------------
    // Only when content changed (or this is a first crawl): re-queueing the
    // same neighborhood on every unchanged recrawl would burn the budget
    // for zero new information.
    if (job.depth < this.settings.maxDepth && (changed || !isRecrawl)) {
      const maxLinks = this.settings.ecoMode ? 5 : 10;
      let added = 0;
      for (const link of parsed.links.slice(0, maxLinks)) {
        const normalized = normalizeIndexUrl(link);
        if (!normalized) continue;

        // Don't re-crawl same URL
        if (normalized === job.url) continue;

        // Negative-cached failures aren't worth re-discovering.
        if (await isFailureCached(normalized)) continue;

        const enqueued = await this.enqueue(
          {
            url: normalized,
            priority: job.priority * 0.8,
            depth: job.depth + 1,
            discoveredFrom: job.url,
            attempts: 0,
          },
          true,
        );
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
    this.scheduler.noteRequest(feedUrl); // feed fetch = same-origin load
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

      // Trap guards apply to feed-discovered URLs too.
      if (isLikelyCrawlTrap(normalized)) {
        this.stats.trapsBlocked++;
        continue;
      }

      // Skip entries we already know about (fetched, observed, or failed).
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
          source: CRAWLER_SOURCE,
          network: 'clearnet',
          ...(platform ? { platform } : {}),
          type: 'article',
        });
        await this.notePublishResult(publishedObservation?.delivered);
        if (publishedObservation && publishedObservation.delivered > 0) {
          this.stats.published++;
        }
        this.stats.pagesIndexed++;
      }

      // And queue it for a real page fetch at lower priority.
      const enqueued = await this.enqueue(
        {
          url: normalized,
          priority: fromJob.priority * 0.6,
          depth: fromJob.depth + 1,
          discoveredFrom: feedUrl,
          attempts: 0,
        },
        true,
      );
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
      this.scheduler.noteRequest(sitemapUrl);
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
        if (isLikelyCrawlTrap(normalized)) {
          this.stats.trapsBlocked++;
          continue;
        }
        // Only skip URLs we ACTUALLY fetched — observed ones still get a real fetch.
        if (await isFetched(normalized)) continue;
        if (await isFailureCached(normalized)) continue;

        const enqueued = await this.enqueue(
          {
            url: normalized,
            priority: fromJob.priority * 0.5,
            depth: fromJob.depth + 1,
            discoveredFrom: sitemapUrl,
            attempts: 0,
          },
          true,
        );
        if (enqueued) added++;
      }

      // Sitemap index: follow ONE child sitemap for a taste of what's inside.
      if (sitemap.sitemaps.length > 0 && sitemap.urls.length === 0) {
        const child = sitemap.sitemaps[Math.floor(Math.random() * sitemap.sitemaps.length)];
        this.scheduler.noteRequest(child);
        const childXml = await fetchXml(child);
        if (childXml && looksLikeSitemap(childXml)) {
          const childSitemap = parseSitemap(childXml, child);
          if (childSitemap) {
            const childSample = sampleUrls(childSitemap.urls, this.settings.ecoMode ? 10 : 25);
            for (const url of childSample) {
              const normalized = normalizeIndexUrl(url);
              if (!normalized) continue;
              if (isLikelyCrawlTrap(normalized)) {
                this.stats.trapsBlocked++;
                continue;
              }
              if (await isFetched(normalized)) continue;
              if (await isFailureCached(normalized)) continue;
              const enqueued = await this.enqueue(
                {
                  url: normalized,
                  priority: fromJob.priority * 0.5,
                  depth: fromJob.depth + 1,
                  discoveredFrom: child,
                  attempts: 0,
                },
                true,
              );
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

  /* ------------------------------------------------------------------ */
  /* Heartbeat, outbox, maintenance, publish lane                        */
  /* ------------------------------------------------------------------ */

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

  /**
   * Storage maintenance: expired negative-cache entries are deleted (so a
   * future discovery may retry the URL) and the crawled store is capped.
   * Runs once at start and hourly while crawling.
   */
  private startMaintenance(): void {
    this.stopMaintenance();
    this.maintenanceTimer = setInterval(() => {
      void maintenanceSweep().then(({ failedExpired, evicted }) => {
        if (failedExpired > 0 || evicted > 0) {
          console.debug(`[Crawler] Maintenance: ${failedExpired} expired failures, ${evicted} evicted`);
        }
      });
    }, 60 * 60 * 1000);
  }

  private stopMaintenance(): void {
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }
  }

  /** Track a fire-and-forget publish so stop() can drain the lane. */
  private trackPublish(promise: Promise<void>): void {
    const tracked = promise.finally(() => {
      this.publishLane.delete(tracked);
    });
    this.publishLane.add(tracked);
  }

  private async flushOutbox(): Promise<void> {
    try {
      const delivered = await flushObservationOutbox();
      if (delivered > 0) {
        console.debug(`[Crawler] Outbox flushed ${delivered} held observation(s)`);
        this.stats.published += delivered;
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
        published: this.stats.published,
      });
      await publishHeartbeatEvent(event);
    } catch (error) {
      // Heartbeats are best-effort; a missed beat just reads as offline.
      console.debug('[Crawler] Heartbeat failed:', error);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Resource gates + sleeping                                           */
  /* ------------------------------------------------------------------ */

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

  private sleep(ms: number, ac: AbortController | null = this.abortController): Promise<void> {
    return new Promise((resolve) => {
      const timeout = setTimeout(resolve, ms);
      ac?.signal.addEventListener('abort', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  /** Sleep until a wake event, the timeout, or abort — whichever first. */
  private waitForWake(timeoutMs: number, ac: AbortController | null = this.abortController): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      // Declared FIRST: every consumer below captures this binding, and the
      // timeout registration evaluates it immediately (a const used before
      // its declaration throws a TDZ ReferenceError — the v2.0.0 bug).
      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ac?.signal.removeEventListener('abort', onAbort);
        this.wakeListeners.delete(listener);
        resolve();
      };
      const timer = setTimeout(cleanup, timeoutMs);
      const onAbort = () => cleanup();
      const listener = () => cleanup();
      ac?.signal.addEventListener('abort', onAbort, { once: true });
      this.wakeListeners.add(listener);
    });
  }

  /** Wake all sleeping slot runners (new admissions, shutdown). */
  private wake(): void {
    for (const listener of this.wakeListeners) listener();
  }
}
