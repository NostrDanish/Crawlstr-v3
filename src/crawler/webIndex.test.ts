import { describe, it, expect } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';
import {
  normalizeIndexUrl,
  documentId,
  contentHash,
  buildIndexEvent,
  parseIndexEvent,
  verifyObservation,
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

/* ------------------------------------------------------------------------ */
/* Reader side — spec §18 search-node behavior                              */
/* ------------------------------------------------------------------------ */

function fakeEvent(partial: Partial<NostrEvent>): NostrEvent {
  return {
    id: '0'.repeat(64),
    pubkey: 'f'.repeat(64),
    sig: '0'.repeat(128),
    kind: SIP01_KIND,
    created_at: 1786250000,
    content: '{"title":"Example Page","description":"A page about examples."}',
    tags: [
      ['d', 'widx:3641c5f2274c5471278ab5bf1df6d185'],
      ['u', 'https://example.com/page'],
      ['x', '2a5cbdf44513f552fb571d6c6de2ddf16c5452b235cc887980b52898fb38e7c1'],
      ['v', '1'],
      ['alt', 'Web index observation: Example Page'],
    ],
    ...partial,
  };
}

describe('parseIndexEvent — reader side (spec §18)', () => {
  it('parses a well-formed observation', () => {
    const obs = parseIndexEvent(fakeEvent({}));
    expect(obs).not.toBeNull();
    expect(obs!.d).toBe('widx:3641c5f2274c5471278ab5bf1df6d185');
    expect(obs!.url).toBe('https://example.com/page');
    expect(obs!.title).toBe('Example Page');
    expect(obs!.description).toBe('A page about examples.');
    expect(obs!.contentHash).toBe(
      '2a5cbdf44513f552fb571d6c6de2ddf16c5452b235cc887980b52898fb38e7c1',
    );
    expect(obs!.indexer).toBe('f'.repeat(64));
    expect(obs!.observedAt).toBe(1786250000);
  });

  it('rejects the wrong kind', () => {
    expect(parseIndexEvent(fakeEvent({ kind: 1 }))).toBeNull();
  });

  it('rejects a missing or malformed d tag', () => {
    const noD = fakeEvent({ tags: fakeEvent({}).tags.filter(([n]) => n !== 'd') });
    expect(parseIndexEvent(noD)).toBeNull();

    const badD = fakeEvent({
      tags: fakeEvent({}).tags.map(([n, v]) => (n === 'd' ? ['d', 'notwidx:xyz'] : [n, v])),
    });
    expect(parseIndexEvent(badD)).toBeNull();
  });

  it('rejects an unsupported schema version (spec §10)', () => {
    const v2 = fakeEvent({
      tags: fakeEvent({}).tags.map(([n, v]) => (n === 'v' ? ['v', '2'] : [n, v])),
    });
    expect(parseIndexEvent(v2)).toBeNull();
  });

  it('rejects a non-http(s) u tag (spec §11)', () => {
    const bad = fakeEvent({
      tags: fakeEvent({}).tags.map(([n, v]) => (n === 'u' ? ['u', 'javascript:alert(1)'] : [n, v])),
    });
    expect(parseIndexEvent(bad)).toBeNull();
  });

  it('rejects unparseable content JSON and empty titles', () => {
    expect(parseIndexEvent(fakeEvent({ content: 'not json' }))).toBeNull();
    expect(parseIndexEvent(fakeEvent({ content: '{"title":"  "}' }))).toBeNull();
    expect(parseIndexEvent(fakeEvent({ content: '{"description":"no title"}' }))).toBeNull();
  });

  it('collects registered extension tags (spec §9.2)', () => {
    const withExt = fakeEvent({
      tags: [
        ...fakeEvent({}).tags,
        ['type', 'repository'],
        ['platform', 'github'],
        ['network', 'clearnet'],
      ],
    });
    const obs = parseIndexEvent(withExt);
    expect(obs!.extensions).toEqual({ type: 'repository', platform: 'github', network: 'clearnet' });
  });
});

describe('verifyObservation — integrity (spec §18 step 2)', () => {
  it('accepts a self-consistent event (spec §4 example)', async () => {
    const obs = parseIndexEvent(fakeEvent({}));
    expect(obs).not.toBeNull();
    expect(await verifyObservation(obs!)).toBe(true);
  });

  it('rejects a spoofed d tag squatting on a popular URL', async () => {
    const spoofed = fakeEvent({
      tags: fakeEvent({}).tags.map(([n, v]) =>
        n === 'd' ? ['d', 'widx:00000000000000000000000000000000'] : [n, v],
      ),
    });
    const obs = parseIndexEvent(spoofed);
    expect(obs).not.toBeNull(); // shape is fine…
    expect(await verifyObservation(obs!)).toBe(false); // …but the hashes disagree
  });

  it('rejects a tampered content hash', async () => {
    const tampered = fakeEvent({
      tags: fakeEvent({}).tags.map(([n, v]) => (n === 'x' ? ['x', '0'.repeat(64)] : [n, v])),
    });
    const obs = parseIndexEvent(tampered);
    expect(await verifyObservation(obs!)).toBe(false);
  });

  it('skips the x check when the tag is absent', async () => {
    const noX = fakeEvent({ tags: fakeEvent({}).tags.filter(([n]) => n !== 'x') });
    const obs = parseIndexEvent(noX);
    expect(await verifyObservation(obs!)).toBe(true);
  });

  it('round-trips: build → parse → verify', async () => {
    const unsigned = await buildIndexEvent({
      url: 'https://example.com/page',
      title: 'Example Page',
      description: 'A page about examples.',
      tags: ['nostr'],
      language: 'en',
      source: 'crawlstr/v2',
      type: 'page',
      network: 'clearnet',
    });
    expect(unsigned).not.toBeNull();

    const event = fakeEvent({
      content: unsigned!.content,
      tags: unsigned!.tags,
    });
    const obs = parseIndexEvent(event);
    expect(obs).not.toBeNull();
    expect(await verifyObservation(obs!)).toBe(true);
  });
});
