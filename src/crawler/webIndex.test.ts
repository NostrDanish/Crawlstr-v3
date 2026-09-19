import { describe, it, expect } from 'vitest';
import {
  normalizeIndexUrl,
  documentId,
  contentHash,
  buildIndexEvent,
  SIP01_KIND,
  SIP01_SCHEMA_VERSION,
} from './webIndex';

/**
 * These are the SIP-01 spec's own test vectors (§13), verbatim from
 * https://github.com/NostrDanish/SIP-01 — public/spec/SIP-01.md.
 *
 * If any of these fail, our events will not deduplicate against events from
 * 0xSearchstr, 0xPresearchstr, UNCAGED-ENGINE, or the UNCAGED Index Relay —
 * the `d` tags would silently diverge and the "N independent indexers" model
 * would break.
 */

describe('normalizeIndexUrl — spec §13.1 vectors', () => {
  it('keeps a bare root URL unchanged', () => {
    expect(normalizeIndexUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('applies every normalization rule together', () => {
    // scheme/host lowercased, www. stripped, default port removed, fragment
    // removed, tracking param removed, remaining params sorted, trailing
    // slash removed.
    expect(
      normalizeIndexUrl('HTTPS://WWW.Example.Com:443/page/?b=2&utm_source=x&a=1#top'),
    ).toBe('https://example.com/page?a=1&b=2');
  });

  it('leaves an already-normalized URL unchanged', () => {
    expect(normalizeIndexUrl('https://example.com/page')).toBe('https://example.com/page');
  });

  it('does NOT lowercase the path — only scheme and host', () => {
    expect(normalizeIndexUrl('https://github.com/NostrDanish/Crwalstr')).toBe(
      'https://github.com/NostrDanish/Crwalstr',
    );
  });

  it('rejects non-http(s) URLs', () => {
    expect(normalizeIndexUrl('ftp://example.com/file')).toBeNull();
    expect(normalizeIndexUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeIndexUrl('data:text/html,<p>hi</p>')).toBeNull();
    expect(normalizeIndexUrl('not a url')).toBeNull();
  });
});

describe('documentId — spec §13.1 vectors', () => {
  it('matches the spec d tags', async () => {
    expect(await documentId('https://example.com/')).toBe('widx:0f115db062b7c0dd030b16878c99dea5');
    expect(await documentId('https://example.com/page?a=1&b=2')).toBe('widx:f68176b3eb966bd682c3c6eadcc5fe44');
    expect(await documentId('https://example.com/page')).toBe('widx:3641c5f2274c5471278ab5bf1df6d185');
    expect(await documentId('https://github.com/NostrDanish/Crwalstr')).toBe('widx:cdfd4df8c01d609fc9cdf943afa80197');
  });
});

describe('contentHash — spec §13.2 vectors', () => {
  it('treats an absent description as the empty string', async () => {
    expect(await contentHash('Example', '')).toBe(
      'e1762f14d9924e37b32f1c81dfd256410af462f5136415c96877efa8c80345d0',
    );
  });

  it('matches the spec x tag for title + newline + description', async () => {
    expect(await contentHash('Example Page', 'A page about examples.')).toBe(
      '2a5cbdf44513f552fb571d6c6de2ddf16c5452b235cc887980b52898fb38e7c1',
    );
  });
});

describe('buildIndexEvent — spec §5/§6 compliance', () => {
  it('builds the spec §4 example event shape', async () => {
    const event = await buildIndexEvent({
      url: 'https://example.com/page',
      title: 'Example Page',
      description: 'A page about examples.',
      image: 'https://example.com/og.jpg',
      tags: ['nostr', 'privacy'],
      language: 'en',
      published: 1786200000,
      source: 'crawlstr/1',
    });

    expect(event).not.toBeNull();
    expect(event!.kind).toBe(SIP01_KIND);

    const tags = event!.tags;
    const tag = (name: string) => tags.find(([n]) => n === name)?.[1];

    expect(tag('d')).toBe('widx:3641c5f2274c5471278ab5bf1df6d185');
    expect(tag('u')).toBe('https://example.com/page');
    expect(tag('x')).toBe('2a5cbdf44513f552fb571d6c6de2ddf16c5452b235cc887980b52898fb38e7c1');
    expect(tag('v')).toBe(SIP01_SCHEMA_VERSION);
    expect(tag('l')).toBe('en');
    expect(tag('published')).toBe('1786200000');
    expect(tag('source')).toBe('crawlstr/1');
    expect(tag('alt')).toBe('Web index observation: Example Page');
    expect(tags.filter(([n]) => n === 't').map(([, v]) => v)).toEqual(['nostr', 'privacy']);

    const content = JSON.parse(event!.content);
    expect(content).toEqual({
      title: 'Example Page',
      description: 'A page about examples.',
      image: 'https://example.com/og.jpg',
    });
  });

  it('omits `published` for non-positive or non-finite dates (finding C-1)', async () => {
    // Relay validator: published must match /^\d{1,16}$/ — a pre-1970 page
    // date produces a negative value and the WHOLE event is rejected.
    for (const published of [-1, -15608000 /* 1969-07-01 */, 0, NaN, Infinity]) {
      const event = await buildIndexEvent({
        url: 'https://example.com/page',
        title: 'Example Page',
        published,
      });
      expect(event).not.toBeNull();
      expect(event!.tags.find(([n]) => n === 'published')).toBeUndefined();
    }
  });

  it('emits `published` as floored unix seconds for positive dates', async () => {
    const event = await buildIndexEvent({
      url: 'https://example.com/page',
      title: 'Example Page',
      published: 1786200000.9,
    });
    expect(event!.tags.find(([n]) => n === 'published')?.[1]).toBe('1786200000');
  });

  it('drops a non-https image (spec §11)', async () => {
    const event = await buildIndexEvent({
      url: 'https://example.com/page',
      title: 'Example Page',
      image: 'http://example.com/og.jpg',
    });
    const content = JSON.parse(event!.content);
    expect(content.image).toBeUndefined();
  });

  it('drops an invalid language tag instead of emitting it', async () => {
    const event = await buildIndexEvent({
      url: 'https://example.com/page',
      title: 'Example Page',
      language: 'english', // not a two-letter code
    });
    expect(event!.tags.find(([n]) => n === 'l')).toBeUndefined();
  });

  it('drops topic tags that fail the spec regex', async () => {
    const event = await buildIndexEvent({
      url: 'https://example.com/page',
      title: 'Example Page',
      tags: ['valid-tag', '-bad', 'also_ok', 'UPPERCASE'],
    });
    const topics = event!.tags.filter(([n]) => n === 't').map(([, v]) => v);
    // UPPERCASE is lowercased by the builder, then passes; -bad and also_ok
    // fail the spec §6 regex ^[a-z0-9][a-z0-9-]{0,99}$ (no leading dash, no
    // underscores).
    expect(topics).toContain('valid-tag');
    expect(topics).toContain('uppercase');
    expect(topics).not.toContain('-bad');
    expect(topics).not.toContain('also_ok');
  });

  it('validates extension registry values (spec §9.1 rule 5)', async () => {
    const event = await buildIndexEvent({
      url: 'https://github.com/NostrDanish/Crwalstr',
      title: 'Crwalstr — a browser-based web crawler for Nostr',
      description: 'A browser-based web crawler that publishes SIP-01 web index observations.',
      tags: ['nostr', 'crawler', 'search'],
      language: 'en',
      source: 'crawlstr/1',
      type: 'repository',
      platform: 'github',
      network: 'clearnet',
    });

    const tags = event!.tags;
    const tag = (name: string) => tags.find(([n]) => n === name)?.[1];
    expect(tag('d')).toBe('widx:cdfd4df8c01d609fc9cdf943afa80197');
    expect(tag('type')).toBe('repository');
    expect(tag('platform')).toBe('github');
    expect(tag('network')).toBe('clearnet');
  });

  it('rejects an event with an over-long URL', async () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(2100);
    expect(await buildIndexEvent({ url: longUrl, title: 'Too long' })).toBeNull();
  });

  it('returns null for an empty title', async () => {
    expect(await buildIndexEvent({ url: 'https://example.com/', title: '   ' })).toBeNull();
  });
});
