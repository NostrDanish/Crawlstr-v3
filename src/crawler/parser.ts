// HTML parser — extracts content and discovery signals from crawled pages

import { detectFeeds, type FeedLink } from './feed';
import type { ParsedPage } from './types';

export function parsePage(html: string, baseUrl: string): ParsedPage {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Extract title
  const title = doc.querySelector('title')?.textContent?.trim() ??
    doc.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim() ??
    '';

  // Extract description
  const description =
    doc.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() ??
    doc.querySelector('meta[property="og:description"]')?.getAttribute('content')?.trim() ??
    '';

  // Representative image (SIP-01 §6: https-only, enforced at build time too).
  // og:image content is frequently relative — resolve against the page URL.
  const imageRaw =
    doc.querySelector('meta[property="og:image"]')?.getAttribute('content')?.trim() ??
    doc.querySelector('meta[name="twitter:image"]')?.getAttribute('content')?.trim() ??
    '';
  let image = '';
  if (imageRaw) {
    try {
      image = new URL(imageRaw, baseUrl).href;
    } catch {
      image = '';
    }
  }

  // Claimed publication time (SIP-01 §6: `published` tag, unix seconds)
  const publishedRaw =
    doc.querySelector('meta[property="article:published_time"]')?.getAttribute('content')?.trim() ??
    doc.querySelector('meta[name="date"]')?.getAttribute('content')?.trim() ??
    doc.querySelector('time[datetime]')?.getAttribute('datetime')?.trim() ??
    '';
  const publishedTs = publishedRaw ? Math.floor(new Date(publishedRaw).getTime() / 1000) : NaN;
  // Clamp defensively (SIP-01 finding C-1): a page claiming a pre-1970 date
  // yields a negative timestamp, and relays reject a negative `published`
  // tag wholesale. Drop non-positive claims here, before the builder.
  const published = Number.isFinite(publishedTs) && publishedTs > 0 ? publishedTs : undefined;

  // RSS / Atom feeds linked from the page (discovery signal)
  const feeds: FeedLink[] = detectFeeds(doc, baseUrl);

  // Canonical URL the page claims for itself (dedup signal)
  const canonicalRaw = doc.querySelector('link[rel="canonical"]')?.getAttribute('href')?.trim() ?? '';
  let canonical = '';
  if (canonicalRaw) {
    try {
      canonical = new URL(canonicalRaw, baseUrl).href;
    } catch {
      canonical = '';
    }
  }

  // Keywords → SIP-01 topic tags (validated against TOPIC_RE at build time)
  const keywordsRaw = doc.querySelector('meta[name="keywords"]')?.getAttribute('content')?.trim() ?? '';
  const keywords = keywordsRaw
    ? keywordsRaw.split(',').map((k) => k.trim()).filter(Boolean).slice(0, 8)
    : [];

  // Remove non-content elements
  const removeSelectors = 'script, style, noscript, iframe, nav, footer, header, aside, [role="navigation"], [role="banner"], [role="contentinfo"], .nav, .navbar, .sidebar, .footer, .header, .menu, .ad, .ads, .advertisement, .social-share, .comments';
  doc.querySelectorAll(removeSelectors).forEach(el => el.remove());

  // Extract main content
  const mainContent =
    doc.querySelector('main') ??
    doc.querySelector('article') ??
    doc.querySelector('[role="main"]') ??
    doc.querySelector('.content') ??
    doc.querySelector('#content') ??
    doc.body;

  const text = mainContent?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const wordCount = text.split(/\s+/).filter(Boolean).length;

  // Detect language
  const language = doc.documentElement.lang?.split('-')[0] ?? 'en';

  // Extract links
  const linkElements = doc.querySelectorAll('a[href]');
  const links: string[] = [];

  linkElements.forEach(el => {
    const href = el.getAttribute('href');
    if (!href) return;

    try {
      const absoluteUrl = new URL(href, baseUrl).href;
      // Only include http(s) links, no fragments, no mailto/tel
      if (absoluteUrl.startsWith('http') && !absoluteUrl.includes('#')) {
        links.push(absoluteUrl);
      }
    } catch {
      // Invalid URL, skip
    }
  });

  return {
    title,
    description,
    image,
    published,
    feeds,
    canonical,
    keywords,
    text: text.slice(0, 10000), // Cap text at 10k chars for storage
    language,
    links: [...new Set(links)], // Deduplicate
    wordCount,
  };
}
