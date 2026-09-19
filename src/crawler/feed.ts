/**
 * RSS 2.0 / Atom feed discovery and parsing.
 *
 * Feeds are the cheapest high-quality crawl source on the web: one small XML
 * document yields a list of current, canonical content URLs with titles,
 * summaries and dates — a fraction of the bandwidth of crawling pages.
 *
 * Everything here is synchronous XML parsing; fetching is the fetcher's job.
 */

export interface FeedLink {
  url: string;
  /** 'rss' | 'atom' — whatever the link tag claimed. */
  kind: string;
}

export interface FeedEntry {
  url: string;
  title: string;
  summary?: string;
  published?: number;
}

export interface ParsedFeed {
  title: string;
  entries: FeedEntry[];
}

/** Detect RSS/Atom feeds linked from a parsed HTML document. */
export function detectFeeds(doc: Document, baseUrl: string): FeedLink[] {
  const feeds: FeedLink[] = [];
  const seen = new Set<string>();

  const links = doc.querySelectorAll(
    'link[rel="alternate"][type*="rss"], link[rel="alternate"][type*="atom"], link[rel="alternate"][type*="xml"]',
  );

  links.forEach((el) => {
    const href = el.getAttribute('href');
    const type = (el.getAttribute('type') ?? '').toLowerCase();
    if (!href) return;
    try {
      const url = new URL(href, baseUrl).href;
      if (!url.startsWith('http') || seen.has(url)) return;
      seen.add(url);
      feeds.push({ url, kind: type.includes('atom') ? 'atom' : 'rss' });
    } catch {
      // Invalid URL, skip
    }
  });

  return feeds;
}

/** True when the text looks like a feed document. */
export function looksLikeFeed(xml: string): boolean {
  const head = xml.slice(0, 2000);
  return head.includes('<rss') || head.includes('<feed') || head.includes('<rdf:RDF');
}

/** True when the text looks like a sitemap document. */
export function looksLikeSitemap(xml: string): boolean {
  const head = xml.slice(0, 2000);
  return head.includes('<urlset') || head.includes('<sitemapindex');
}

/** Parse an RSS 2.0 or Atom feed document. Returns null when unrecognizable. */
export function parseFeed(xml: string, feedUrl: string, maxEntries = 10): ParsedFeed | null {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (doc.querySelector('parsererror')) return null;

  // --- Atom ---
  const atomEntries = doc.querySelectorAll('feed > entry');
  if (atomEntries.length > 0) {
    const title = doc.querySelector('feed > title')?.textContent?.trim() ?? '';
    const entries: FeedEntry[] = [];

    atomEntries.forEach((entry, i) => {
      if (i >= maxEntries) return;
      const entryTitle = entry.querySelector('title')?.textContent?.trim() ?? '';
      // Atom link: prefer <link rel="alternate" href>, then first <link href>
      const linkEl =
        entry.querySelector('link[rel="alternate"]') ?? entry.querySelector('link');
      const href = linkEl?.getAttribute('href') ?? linkEl?.textContent?.trim() ?? '';
      const dateRaw =
        entry.querySelector('published')?.textContent?.trim() ??
        entry.querySelector('updated')?.textContent?.trim() ??
        '';
      const summary =
        entry.querySelector('summary')?.textContent?.trim() ??
        entry.querySelector('content')?.textContent?.trim().slice(0, 500) ??
        '';

      if (!href) return;
      try {
        const url = new URL(href, feedUrl).href;
        if (!url.startsWith('http')) return;
        const ts = dateRaw ? Math.floor(new Date(dateRaw).getTime() / 1000) : NaN;
        entries.push({
          url,
          title: entryTitle || url,
          summary: summary || undefined,
          published: Number.isFinite(ts) && ts > 0 ? ts : undefined, // C-1: drop pre-1970 claims
        });
      } catch {
        // Invalid URL, skip
      }
    });

    return { title, entries };
  }

  // --- RSS 2.0 / RDF ---
  const items = doc.querySelectorAll('channel > item, item');
  if (items.length > 0) {
    const title = doc.querySelector('channel > title')?.textContent?.trim() ?? '';
    const entries: FeedEntry[] = [];

    items.forEach((item, i) => {
      if (i >= maxEntries) return;
      const entryTitle = item.querySelector('title')?.textContent?.trim() ?? '';
      const link = item.querySelector('link')?.textContent?.trim() ?? '';
      const guid = item.querySelector('guid')?.textContent?.trim() ?? '';
      const dateRaw = item.querySelector('pubDate')?.textContent?.trim() ?? '';
      const summary = item.querySelector('description')?.textContent?.trim().slice(0, 500) ?? '';

      const href = link || guid;
      if (!href) return;
      try {
        const url = new URL(href, feedUrl).href;
        if (!url.startsWith('http')) return;
        const ts = dateRaw ? Math.floor(new Date(dateRaw).getTime() / 1000) : NaN;
        entries.push({
          url,
          title: entryTitle || url,
          summary: summary || undefined,
          published: Number.isFinite(ts) && ts > 0 ? ts : undefined, // C-1: drop pre-1970 claims
        });
      } catch {
        // Invalid URL, skip
      }
    });

    return { title, entries };
  }

  return null;
}
