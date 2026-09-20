// React hook for the crawler engine
// Wires up SIP-01 publishing via targeted per-relay Nostr connections

import { useEffect, useRef, useState, useCallback } from 'react';
import { useNostr } from '@nostrify/react';
import { CrawlerEngine, type SessionSummary } from '@/crawler/engine';
import { setRelayPublisher, getIndexerInfo } from '@/crawler/publisher';
import { seedCount, scoutedCount, getCategories, categoryOf } from '@/crawler/seeds';
import { CRAWL_MODES, type CrawlMode, type CrawlerStats, type CrawlerSettings } from '@/crawler/types';

export interface ScoutPreview {
  url: string;
  category: string;
}

export function useCrawler() {
  const { nostr } = useNostr();
  const engineRef = useRef<CrawlerEngine | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [mode, setMode] = useState<CrawlMode>('site');
  const [currentSeed, setCurrentSeed] = useState<string | null>(null);
  const [scoutPreview, setScoutPreview] = useState<ScoutPreview | null>(null);
  const [lastSession, setLastSession] = useState<SessionSummary | null>(null);
  const [stats, setStats] = useState<CrawlerStats>({
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
  });
  const [recentCrawls, setRecentCrawls] = useState<Array<{
    url: string;
    title: string;
    crawledAt: number;
    status: 'fetched' | 'observed' | 'failed';
  }>>([]);
  const [indexerInfo, setIndexerInfo] = useState<{ pubkeyHex: string; npub: string } | null>(null);

  // Initialize engine and indexer identity
  useEffect(() => {
    const engine = new CrawlerEngine();
    engine.init().then(() => {
      engineRef.current = engine;
      setInitialized(true);
      setStats(engine.getStats());
      setIndexerInfo(getIndexerInfo());
    });

    engine.onStats((newStats) => {
      setStats(newStats);
      // Engine can auto-stop when a session budget is spent.
      if (!engine.isRunning()) setIsRunning(false);
    });

    engine.onMode((newMode) => {
      setMode(newMode);
    });

    engine.onSessionComplete((summary) => {
      setLastSession(summary);
      setCurrentSeed(null);
    });

    return () => {
      engine.stop();
    };
  }, []);

  // Wire up relay publishing. Each crawl observation is pushed to every relay
  // in the index publish set via a targeted per-relay connection — the crawler
  // list is authoritative, not merely decorative.
  useEffect(() => {
    setRelayPublisher(async (relayUrl, event) => {
      try {
        await nostr.relay(relayUrl).event(event, { signal: AbortSignal.timeout(10000) });
      } catch (error) {
        console.debug(`[Crawler] Publish failed for ${relayUrl}:`, error);
        // The publisher tracks per-relay health and routes zero-accept
        // events into the IndexedDB outbox — it must see the failure.
        throw error;
      }
    });
  }, [nostr]);

  // Poll recent crawls
  useEffect(() => {
    if (!initialized) return;

    const loadRecent = async () => {
      if (engineRef.current) {
        const recent = await engineRef.current.getRecentCrawls(20);
        setRecentCrawls(recent);
      }
    };

    loadRecent();
    const interval = setInterval(loadRecent, 10000);
    return () => clearInterval(interval);
  }, [initialized, isRunning]);

  const start = useCallback(async (crawlMode?: CrawlMode) => {
    if (!engineRef.current) return;
    await engineRef.current.start(crawlMode);
    setIsRunning(true);
    if (crawlMode) setMode(crawlMode);
  }, []);

  const stop = useCallback(async () => {
    if (!engineRef.current) return;
    await engineRef.current.stop();
    setIsRunning(false);
  }, []);

  const setModePreference = useCallback((crawlMode: CrawlMode) => {
    if (!engineRef.current) return;
    engineRef.current.setMode(crawlMode);
    setMode(crawlMode);
  }, []);

  const seedUrl = useCallback(async (url: string) => {
    if (!engineRef.current) return;
    await engineRef.current.seedUrl(url);
    setCurrentSeed(engineRef.current.getCurrentSeed());
  }, []);

  /** Random Scout: pick a seed the device hasn't scouted, start crawling. */
  const scoutRandom = useCallback(async (crawlMode?: CrawlMode): Promise<string | null> => {
    const engine = engineRef.current;
    if (!engine) return null;
    if (crawlMode && crawlMode !== mode) setMode(crawlMode);
    const seed = await engine.scoutRandom(crawlMode);
    if (seed) {
      setIsRunning(true);
      setCurrentSeed(seed);
    }
    return seed;
  }, [mode]);

  /** Preview a random seed without committing — for the "🎲 Random corner" card. */
  const previewScout = useCallback((categoryId?: string): ScoutPreview | null => {
    const engine = engineRef.current;
    if (!engine) return null;
    const preview = engine.previewSeed(categoryId);
    setScoutPreview(preview);
    return preview;
  }, []);

  /** Start scouting the previewed seed. */
  const confirmScout = useCallback(async (crawlMode?: CrawlMode): Promise<void> => {
    const engine = engineRef.current;
    if (!engine || !scoutPreview) return;
    if (crawlMode && crawlMode !== mode) setMode(crawlMode);
    setLastSession(null);
    await engine.startScout(scoutPreview.url, crawlMode);
    setCurrentSeed(scoutPreview.url);
    setScoutPreview(null);
    setIsRunning(true);
  }, [scoutPreview, mode]);

  const dismissScoutPreview = useCallback(() => {
    setScoutPreview(null);
  }, []);

  /** Dismiss the "SCOUT COMPLETE" summary card. */
  const dismissSessionSummary = useCallback(() => {
    setLastSession(null);
  }, []);

  /**
   * Random Scout (v2 simplified UX): queues a bundle of 5 fresh curated
   * seeds and starts explorer mode — keeps pulling new bundles until
   * stopped. Returns the seeds queued (empty when the corpus is exhausted).
   */
  const startScoutBundle = useCallback(async (): Promise<string[]> => {
    const engine = engineRef.current;
    if (!engine) return [];
    setLastSession(null);
    const seeds = await engine.startScoutBundle();
    if (seeds.length > 0) {
      setIsRunning(true);
      setCurrentSeed(seeds[0]);
    }
    return seeds;
  }, []);

  /** One-control scout toggle: running → stop; stopped → fresh bundle + start. */
  const toggleScout = useCallback(async (): Promise<void> => {
    const engine = engineRef.current;
    if (!engine) return;
    if (engine.isRunning()) {
      await engine.stop();
      setIsRunning(false);
      return;
    }
    await startScoutBundle();
  }, [startScoutBundle]);

  /** Random Explorer: keep scouting fresh random seeds within every limit. */
  const startExplorer = useCallback(async (): Promise<string | null> => {
    if (!engineRef.current) return null;
    const seed = await engineRef.current.startExplorer();
    if (seed) {
      setIsRunning(true);
      setCurrentSeed(seed);
    }
    return seed;
  }, []);

  const clearAll = useCallback(async () => {
    if (!engineRef.current) return;
    await engineRef.current.clearAll();
  }, []);

  const updateSettings = useCallback((settings: Partial<CrawlerSettings>) => {
    if (!engineRef.current) return;
    engineRef.current.updateSettings(settings);
  }, []);

  const getSettings = useCallback((): CrawlerSettings => {
    return engineRef.current?.getSettings() ?? {
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
  }, []);

  return {
    isRunning,
    initialized,
    mode,
    modes: CRAWL_MODES,
    setModePreference,
    currentSeed,
    currentSeedCategory: currentSeed ? categoryOf(currentSeed) : undefined,
    scoutPreview,
    lastSession,
    dismissSessionSummary,
    stats,
    recentCrawls,
    indexerInfo,
    seedCount: seedCount(),
    scoutedCount: scoutedCount(),
    categories: getCategories(),
    start,
    stop,
    seedUrl,
    scoutRandom,
    previewScout,
    confirmScout,
    dismissScoutPreview,
    startScoutBundle,
    toggleScout,
    startExplorer,
    clearAll,
    updateSettings,
    getSettings,
  };
}
