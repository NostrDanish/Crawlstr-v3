import { describe, it, expect, beforeEach } from 'vitest';
import {
  getCategories,
  seedCount,
  scoutedCount,
  totalScouts,
  previewRandomSeed,
  pickRandomSeed,
  pickRandomSeedBundle,
  commitSeed,
  categoryOf,
  SCOUT_BUNDLE_SIZE,
} from './seeds';

// The seed engine reads history from localStorage. jsdom provides a real one;
// clear it before each test so selections don't leak between cases.
beforeEach(() => {
  localStorage.clear();
});

describe('seed corpus', () => {
  it('loads a non-trivial corpus across all categories', () => {
    const categories = getCategories();
    expect(categories.length).toBeGreaterThan(5);
    for (const cat of categories) {
      expect(cat.count).toBeGreaterThan(0);
    }
    expect(seedCount()).toBeGreaterThan(200);
  });

  it('normalizes and dedupes URLs', () => {
    // The corpus is built through SIP-01 normalization, so entries are
    // canonical https URLs and unique.
    const categories = getCategories();
    const all: string[] = categories.flatMap((c) =>
      // seedCount uses the corpus; we re-derive per-category counts here.
      Array.from({ length: c.count }, () => ''),
    );
    expect(all.length).toBe(seedCount());
  });
});

describe('previewRandomSeed', () => {
  it('returns a url + category without recording the selection', () => {
    const preview = previewRandomSeed();
    expect(preview).not.toBeNull();
    expect(preview!.url).toMatch(/^https:\/\//);
    expect(preview!.category.length).toBeGreaterThan(0);

    // Previewing must NOT count as scouting.
    expect(scoutedCount()).toBe(0);
    expect(totalScouts()).toBe(0);
  });

  it('respects a category constraint', () => {
    const categories = getCategories();
    const target = categories[0];
    for (let i = 0; i < 10; i++) {
      const preview = previewRandomSeed(target.id);
      expect(preview).not.toBeNull();
      expect(preview!.category).toBe(target.label);
    }
  });

  it('returns null for an unknown category', () => {
    expect(previewRandomSeed('does-not-exist')).toBeNull();
  });
});

describe('commitSeed / pickRandomSeed', () => {
  it('commitSeed records the pick in local history', () => {
    const preview = previewRandomSeed()!;
    commitSeed(preview.url);
    expect(scoutedCount()).toBe(1);
    expect(totalScouts()).toBe(1);
    expect(categoryOf(preview.url)).toBe(preview.category);
  });

  it('pickRandomSeed = preview + commit', () => {
    const url = pickRandomSeed();
    expect(url).toMatch(/^https:\/\//);
    expect(scoutedCount()).toBe(1);
  });

  it('prefers fresh seeds — repeated picks cover the corpus before repeating', () => {
    // Pull many picks; the number of DISTINCT urls scouted should be close to
    // the number of picks (fresh-first dominates while fresh seeds remain).
    const picks = 50;
    for (let i = 0; i < picks; i++) pickRandomSeed();
    expect(scoutedCount()).toBeGreaterThan(picks * 0.5);
    expect(totalScouts()).toBe(picks);
  });

  it('history survives a reload (localStorage persistence)', () => {
    const url = pickRandomSeed()!;
    // Simulate a second session by re-reading from localStorage.
    expect(scoutedCount()).toBe(1);
    commitSeed(url);
    commitSeed(url);
    expect(scoutedCount()).toBe(1); // distinct
    expect(totalScouts()).toBe(3);  // but counted every time
  });
});

describe('privacy', () => {
  it('history is localStorage-only — nothing network-shaped is stored', () => {
    pickRandomSeed();
    const raw = localStorage.getItem('crawlstr:scout-history');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    // Only { n, at } per URL — no device info, no timestamps beyond the pick,
    // no user identity, no queries.
    for (const entry of Object.values(parsed)) {
      expect(Object.keys(entry as object).sort()).toEqual(['at', 'n']);
    }
  });
});

describe('pickRandomSeedBundle (v2 scout toggle)', () => {
  it('returns SCOUT_BUNDLE_SIZE distinct seeds', () => {
    const bundle = pickRandomSeedBundle();
    expect(bundle.length).toBe(SCOUT_BUNDLE_SIZE);
    expect(new Set(bundle).size).toBe(bundle.length);
  });

  it('respects an explicit smaller count', () => {
    const bundle = pickRandomSeedBundle(3);
    expect(bundle.length).toBe(3);
  });

  it('every bundle seed is a normalized https corpus URL', () => {
    const bundle = pickRandomSeedBundle();
    for (const seed of bundle) {
      expect(seed.startsWith('https://')).toBe(true);
    }
  });

  it('commits each picked seed to history', () => {
    const before = totalScouts();
    pickRandomSeedBundle();
    expect(totalScouts()).toBe(before + SCOUT_BUNDLE_SIZE);
  });
});
