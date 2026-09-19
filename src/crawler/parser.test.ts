import { describe, it, expect } from 'vitest';
import { parsePage } from './parser';
import { parseFeed } from './feed';
import { buildIndexEvent } from './webIndex';

/**
 * End-to-end clamp for SIP-01 finding C-1: page/feed-claimed dates that are
 * non-positive (pre-1970) must be dropped at the extraction layer, so the
 * event builder never sees — let alone emits — a negative `published` tag
 * that validating relays would reject wholesale.
 */

const page = (meta: string) => `<!doctype html><html><head>
  <title>Test Page</title>
  ${meta}
  </head><body><p>${'word '.repeat(20)}</p></body></html>`;

describe('C-1 end-to-end: pre-1970 dates never reach the wire', () => {
  it('parser drops a pre-1970 article:published_time', () => {
    const parsed = parsePage(
      page('<meta property="article:published_time" content="1965-03-15T00:00:00Z">'),
      'https://example.com/post',
    );
    expect(parsed.published).toBeUndefined();
  });

  it('parser keeps a normal post-1970 publication date', () => {
    const parsed = parsePage(
      page('<meta property="article:published_time" content="2024-06-01T12:00:00Z">'),
      'https://example.com/post',
    );
    expect(parsed.published).toBe(Math.floor(new Date('2024-06-01T12:00:00Z').getTime() / 1000));
  });

  it('parser output feeds the builder: no published tag end-to-end', async () => {
    const parsed = parsePage(
      page('<meta property="article:published_time" content="1900-01-01">'),
      'https://example.com/post',
    );
    const event = await buildIndexEvent({
      url: 'https://example.com/post',
      title: parsed.title,
      description: parsed.description,
      published: parsed.published,
    });
    expect(event).not.toBeNull();
    expect(event!.tags.find(([n]) => n === 'published')).toBeUndefined();
  });

  it('builder still refuses a negative date even if a caller bypasses the parser', async () => {
    const event = await buildIndexEvent({
      url: 'https://example.com/post',
      title: 'Test Page',
      published: -1,
    });
    expect(event!.tags.find(([n]) => n === 'published')).toBeUndefined();
  });

  it('Atom feed entries drop pre-1970 <published> claims', () => {
    const atom = `<?xml version="1.0" encoding="utf-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <title>Example Feed</title>
        <entry>
          <title>Old Post</title>
          <link rel="alternate" href="https://example.com/old" />
          <published>1955-11-12T00:00:00Z</published>
        </entry>
        <entry>
          <title>New Post</title>
          <link rel="alternate" href="https://example.com/new" />
          <published>2024-06-01T12:00:00Z</published>
        </entry>
      </feed>`;
    const feed = parseFeed(atom, 'https://example.com/feed.xml');
    expect(feed).not.toBeNull();
    const old = feed!.entries.find((e) => e.title === 'Old Post');
    const recent = feed!.entries.find((e) => e.title === 'New Post');
    expect(old!.published).toBeUndefined();
    expect(recent!.published).toBe(Math.floor(new Date('2024-06-01T12:00:00Z').getTime() / 1000));
  });

  it('RSS items drop pre-1970 <pubDate> claims', () => {
    const rss = `<?xml version="1.0"?>
      <rss version="2.0"><channel>
        <title>Example RSS</title>
        <item>
          <title>Ancient Item</title>
          <link>https://example.com/ancient</link>
          <pubDate>Mon, 01 Jan 1900 00:00:00 GMT</pubDate>
        </item>
      </channel></rss>`;
    const feed = parseFeed(rss, 'https://example.com/rss.xml');
    expect(feed).not.toBeNull();
    expect(feed!.entries[0].published).toBeUndefined();
  });
});
