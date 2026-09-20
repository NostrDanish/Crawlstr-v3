/**
 * Random Scout seed selection engine.
 *
 * The corpus lives in src/data/seeds/*.txt — one category per file — so
 * improving the dataset never means touching crawler logic. This module is
 * only the selection algorithm.
 *
 * Selection is a weighted mix of strategies (the point is long-tail
 * coverage, not uniform randomness over a fixed list):
 *
 *   40%  fresh      — never picked by this device
 *   25%  rare       — picked least often by this device
 *   15%  category   — from the category this device has explored least
 *   10%  stale      — not picked for the longest time
 *   10%  random     — pure randomness
 *
 * Privacy: selection history lives in localStorage only. Which seed was
 * picked is NEVER published — only the public page observations that
 * result from crawling it.
 */

import { normalizeIndexUrl } from './webIndex';

import nostrTxt from '@/data/seeds/nostr.txt?raw';
import bitcoinTxt from '@/data/seeds/bitcoin.txt?raw';
import devTxt from '@/data/seeds/dev.txt?raw';
import scienceTxt from '@/data/seeds/science.txt?raw';
import booksTxt from '@/data/seeds/books.txt?raw';
import musicTxt from '@/data/seeds/music.txt?raw';
import gamesTxt from '@/data/seeds/games.txt?raw';
import opendataTxt from '@/data/seeds/opendata.txt?raw';
import indieTxt from '@/data/seeds/indie.txt?raw';

export interface SeedCategory {
  id: string;
  label: string;
  urls: string[];
}

const CATEGORIES: Array<{ id: string; label: string; raw: string }> = [
  { id: 'nostr', label: 'Nostr', raw: nostrTxt },
  { id: 'bitcoin', label: 'Bitcoin & Open Money', raw: bitcoinTxt },
  { id: 'dev', label: 'Dev & Awesome Lists', raw: devTxt },
  { id: 'science', label: 'Science & Education', raw: scienceTxt },
  { id: 'books', label: 'Books & Archives', raw: booksTxt },
  { id: 'music', label: 'Music & Culture', raw: musicTxt },
  { id: 'games', label: 'Games', raw: gamesTxt },
  { id: 'opendata', label: 'Open Data & Infrastructure', raw: opendataTxt },
  { id: 'indie', label: 'Indie Web & Blogs', raw: indieTxt },
];

/* ------------------------------------------------------------------ */
/* Corpus                                                              */
/* ------------------------------------------------------------------ */

interface SeedRecord {
  url: string;
  categoryId: string;
}

let cachedCorpus: SeedRecord[] | null = null;

function getCorpus(): SeedRecord[] {
  if (cachedCorpus) return cachedCorpus;

  const seen = new Set<string>();
  const corpus: SeedRecord[] = [];

  for (const cat of CATEGORIES) {
    for (const line of cat.raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const normalized = normalizeIndexUrl(trimmed);
      if (normalized && !seen.has(normalized)) {
        seen.add(normalized);
        corpus.push({ url: normalized, categoryId: cat.id });
      }
    }
  }

  cachedCorpus = corpus;
  return corpus;
}

/** Categories that actually have seeds, with counts. */
export function getCategories(): Array<{ id: string; label: string; count: number }> {
  const corpus = getCorpus();
  return CATEGORIES
    .map((c) => ({ id: c.id, label: c.label, count: corpus.filter((s) => s.categoryId === c.id).length }))
    .filter((c) => c.count > 0);
}

/** Category label for a URL, if it's a known seed. */
export function categoryOf(url: string): string | undefined {
  const record = getCorpus().find((s) => s.url === url);
  if (!record) return undefined;
  return CATEGORIES.find((c) => c.id === record.categoryId)?.label;
}

/* ------------------------------------------------------------------ */
/* Local selection history (never published)                           */
/* ------------------------------------------------------------------ */

const HISTORY_KEY = 'crawlstr:scout-history';
const HISTORY_CAP = 1000;

interface HistoryEntry {
  /** Times this device has scouted this seed. */
  n: number;
  /** Last scouted at (ms). */
  at: number;
}

type History = Record<string, HistoryEntry>;

function readHistory(): History {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as History : {};
  } catch {
    return {};
  }
}

function writeHistory(history: History): void {
  try {
    // Prune oldest beyond the cap.
    const entries = Object.entries(history);
    if (entries.length > HISTORY_CAP) {
      entries.sort((a, b) => a[1].at - b[1].at);
      history = Object.fromEntries(entries.slice(entries.length - HISTORY_CAP));
    }
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    // Storage unavailable — selection simply won't be remembered.
  }
}

/* ------------------------------------------------------------------ */
/* Selection                                                           */
/* ------------------------------------------------------------------ */

/** Strategy mix. Tunable, but these are the defaults. */
const STRATEGY_WEIGHTS = {
  fresh: 40,
  rare: 25,
  category: 15,
  stale: 10,
  random: 10,
} as const;

function pickWeightedStrategy(): keyof typeof STRATEGY_WEIGHTS {
  const total = Object.values(STRATEGY_WEIGHTS).reduce((a, b) => a + b, 0);
  let roll = Math.random() * total;
  for (const [strategy, weight] of Object.entries(STRATEGY_WEIGHTS)) {
    roll -= weight;
    if (roll <= 0) return strategy as keyof typeof STRATEGY_WEIGHTS;
  }
  return 'random';
}

function randomOf<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

/**
 * Select a seed URL using the weighted strategy mix.
 * Optionally constrained to a category.
 */
function selectSeed(corpus: SeedRecord[], history: History): SeedRecord {
  const strategy = pickWeightedStrategy();

  switch (strategy) {
    case 'fresh': {
      const fresh = corpus.filter((s) => !history[s.url]);
      if (fresh.length > 0) return randomOf(fresh);
      return selectSeed(corpus, history); // fall through to another strategy
    }

    case 'rare': {
      const counts = corpus.map((s) => history[s.url]?.n ?? 0);
      const min = Math.min(...counts);
      const rarest = corpus.filter((s) => (history[s.url]?.n ?? 0) === min);
      return randomOf(rarest);
    }

    case 'category': {
      // Explore the least-explored category.
      const catCounts = new Map<string, number>();
      for (const s of corpus) {
        catCounts.set(s.categoryId, (catCounts.get(s.categoryId) ?? 0) + (history[s.url]?.n ?? 0));
      }
      const minCount = Math.min(...catCounts.values());
      const leastExplored = [...catCounts.entries()].filter(([, n]) => n === minCount).map(([id]) => id);
      const catId = randomOf(leastExplored);
      const inCategory = corpus.filter((s) => s.categoryId === catId);
      // Prefer fresh within the category.
      const fresh = inCategory.filter((s) => !history[s.url]);
      return randomOf(fresh.length > 0 ? fresh : inCategory);
    }

    case 'stale': {
      const byAge = [...corpus].sort((a, b) => (history[a.url]?.at ?? 0) - (history[b.url]?.at ?? 0));
      const pool = byAge.slice(0, Math.max(1, Math.ceil(corpus.length / 3)));
      return randomOf(pool);
    }

    case 'random':
    default:
      return randomOf(corpus);
  }
}

/**
 * Preview a random seed WITHOUT recording it. The UI shows the preview
 * ("🎲 Random corner of the web") and the selection is only committed if
 * the user actually starts the scout.
 */
export function previewRandomSeed(categoryId?: string): { url: string; category: string } | null {
  let corpus = getCorpus();
  if (categoryId) {
    corpus = corpus.filter((s) => s.categoryId === categoryId);
    if (corpus.length === 0) return null;
  }
  if (corpus.length === 0) return null;

  const record = selectSeed(corpus, readHistory());
  return { url: record.url, category: CATEGORIES.find((c) => c.id === record.categoryId)?.label ?? record.categoryId };
}

/**
 * Commit a seed selection: record it in local history. Called when a scout
 * actually starts — previews don't count.
 */
export function commitSeed(url: string): void {
  const history = readHistory();
  const entry = history[url];
  history[url] = { n: (entry?.n ?? 0) + 1, at: Date.now() };
  writeHistory(history);
}

/**
 * Pick a random seed and record it immediately (used by the Random
 * Explorer loop, where there's no preview step).
 */
export function pickRandomSeed(categoryId?: string): string | null {
  const preview = previewRandomSeed(categoryId);
  if (!preview) return null;
  commitSeed(preview.url);
  return preview.url;
}

/**
 * How many seeds one Random Scout press queues. A bundle (not a single
 * seed) gives the crawl immediate domain diversity and a fallback: if one
 * corner is unreachable or thin, the other four still carry the session.
 */
export const SCOUT_BUNDLE_SIZE = 5;

/**
 * Pick N DISTINCT random seeds (v2 simplified UX: one press → one bundle →
 * run until stopped). Weighted strategies still apply per pick, so the
 * bundle itself favours fresh/rare corners. Commits each to history.
 */
export function pickRandomSeedBundle(count: number = SCOUT_BUNDLE_SIZE): string[] {
  const picked: string[] = [];
  const seen = new Set<string>();
  let attempts = 0;
  while (picked.length < count && attempts < count * 12) {
    attempts++;
    const seed = pickRandomSeed();
    if (seed && !seen.has(seed)) {
      seen.add(seed);
      picked.push(seed);
    }
  }
  return picked;
}

/* ------------------------------------------------------------------ */
/* Stats for the UI                                                    */
/* ------------------------------------------------------------------ */

/** Number of distinct seeds available. */
export function seedCount(): number {
  return getCorpus().length;
}

/** How many distinct seeds this device has scouted. */
export function scoutedCount(): number {
  return Object.keys(readHistory()).length;
}

/** Total scouts this device has run. */
export function totalScouts(): number {
  return Object.values(readHistory()).reduce((sum, e) => sum + e.n, 0);
}
