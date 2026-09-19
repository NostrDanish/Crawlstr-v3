// robots.txt parser and checker
//
// robots.txt is itself a cross-origin request, so it needs the same CORS proxy
// fallback as page fetches. Without it every lookup failed and the crawler
// "failed open" — claiming to respect robots.txt while ignoring it entirely.

import { CORS_PROXY_TEMPLATE } from './fetcher';
import { recordFetch } from './meter';
import { isPubliclyFetchable } from './safety';

const robotsCache = new Map<string, { rules: RobotsRules; fetchedAt: number }>();
const CACHE_TTL = 3600000; // 1 hour

interface RobotsRules {
  disallowed: string[];
  crawlDelay?: number;
  sitemaps: string[];
}

export async function shouldCrawlUrl(url: string): Promise<boolean> {
  try {
    const urlObj = new URL(url);
    const robotsUrl = `${urlObj.protocol}//${urlObj.host}/robots.txt`;

    const rules = await getRobotsRules(robotsUrl);
    if (!rules) return true; // No robots.txt = allowed

    const path = urlObj.pathname;
    for (const disallowed of rules.disallowed) {
      if (disallowed === '/') return false; // Entire site disallowed
      if (disallowed && path.startsWith(disallowed)) return false;
    }

    return true;
  } catch {
    return true; // Error = assume allowed
  }
}

export async function getCrawlDelay(url: string): Promise<number> {
  try {
    const urlObj = new URL(url);
    const robotsUrl = `${urlObj.protocol}//${urlObj.host}/robots.txt`;
    const rules = await getRobotsRules(robotsUrl);
    return rules?.crawlDelay ?? 0;
  } catch {
    return 0;
  }
}

/** Fetch robots.txt, falling back to the CORS proxy when blocked directly. */
async function fetchRobotsText(robotsUrl: string): Promise<string | null> {
  // SSRF guard — the robots check runs BEFORE fetchPage()'s own guard, so
  // without this a queued private/loopback URL would make the app ask the
  // CORS proxy to fetch e.g. http://169.254.169.254/robots.txt. Refuse
  // non-public targets before ANY request, direct or proxied (audit #1).
  if (!isPubliclyFetchable(robotsUrl)) {
    console.debug('[Crawler] Refused non-public robots.txt URL:', robotsUrl);
    return null;
  }

  const tryOnce = async (requestUrl: string): Promise<string | null> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(requestUrl, {
        signal: controller.signal,
        mode: 'cors',
        credentials: 'omit',
      });
      // 404 = no robots.txt = crawling allowed. Distinguish from network failure.
      if (!response.ok) return '';
      const text = await response.text();
      recordFetch(text.length); // robots.txt traffic counts toward the budget
      return text;
    } finally {
      clearTimeout(timeoutId);
    }
  };

  // Direct first.
  try {
    return await tryOnce(robotsUrl);
  } catch {
    // Almost certainly CORS — retry through the proxy so robots.txt is
    // genuinely honoured instead of silently failing open.
  }

  try {
    return await tryOnce(CORS_PROXY_TEMPLATE.replace('{href}', encodeURIComponent(robotsUrl)));
  } catch {
    return null; // Truly unreachable.
  }
}

async function getRobotsRules(robotsUrl: string): Promise<RobotsRules | null> {
  // Check cache
  const cached = robotsCache.get(robotsUrl);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return cached.rules;
  }

  const text = await fetchRobotsText(robotsUrl);
  if (text === null) return null; // Unreachable — caller decides policy.

  const rules = parseRobotsTxt(text);
  robotsCache.set(robotsUrl, { rules, fetchedAt: Date.now() });
  return rules;
}

function parseRobotsTxt(text: string): RobotsRules {
  const lines = text.split('\n');
  const disallowed: string[] = [];
  const sitemaps: string[] = [];
  let crawlDelay: number | undefined;
  let relevantAgent = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) continue;

    const directive = trimmed.slice(0, colonIndex).trim().toLowerCase();
    const value = trimmed.slice(colonIndex + 1).trim();

    // Sitemap is a global directive — it applies regardless of user-agent.
    if (directive === 'sitemap' && value) {
      sitemaps.push(value);
      continue;
    }

    if (directive === 'user-agent') {
      const agent = value.toLowerCase();
      relevantAgent = agent === '*' || agent.includes('searchstr') || agent.includes('crawlstr');
    }

    if (relevantAgent) {
      if (directive === 'disallow' && value) {
        disallowed.push(value);
      }
      if (directive === 'crawl-delay') {
        const delay = parseInt(value);
        if (!isNaN(delay)) crawlDelay = delay * 1000; // Convert to ms
      }
    }
  }

  return { disallowed, crawlDelay, sitemaps };
}

/**
 * Sitemap URLs declared in a site's robots.txt. Uses the same cache as the
 * crawl-policy checks, so this costs no extra request after a crawl.
 */
export async function getSitemaps(url: string): Promise<string[]> {
  try {
    const urlObj = new URL(url);
    const robotsUrl = `${urlObj.protocol}//${urlObj.host}/robots.txt`;
    const rules = await getRobotsRules(robotsUrl);
    return rules?.sitemaps ?? [];
  } catch {
    return [];
  }
}
