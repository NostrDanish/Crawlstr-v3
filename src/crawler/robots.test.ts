import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { shouldCrawlUrl, getCrawlDelay, getSitemaps } from './robots';

/**
 * SSRF guard on the robots.txt path (audit finding #1).
 *
 * The robots check runs BEFORE fetchPage()'s own isPubliclyFetchable()
 * guard, so robots.ts must refuse private/loopback/link-local targets
 * itself — otherwise the app asks the CORS proxy to fetch e.g.
 * http://169.254.169.254/robots.txt, turning the crawler into an SSRF
 * request oracle against whatever the proxy can reach.
 *
 * fetch is mocked: the core assertion is that for non-public targets it is
 * NEVER called — no direct request and no proxied request.
 *
 * Distinct hostnames per test because robots.ts caches rules per origin.
 */

function mockFetchReturning(status: number, body = '') {
  return vi.fn(async () => new Response(body, { status }));
}

describe('robots.ts SSRF guard (audit finding #1)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetchReturning(404));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refuses to fetch robots.txt for link-local cloud-metadata IPs', async () => {
    const allowed = await shouldCrawlUrl('http://169.254.169.254/latest/meta-data');
    // Fail-open policy is preserved (unreachable robots = allowed)…
    expect(allowed).toBe(true);
    // …but the guard means NOTHING was ever requested, direct or proxied.
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses loopback and RFC1918 robots.txt targets', async () => {
    for (const url of [
      'http://127.0.0.1/admin',
      'http://10.0.0.5/internal',
      'http://192.168.1.1/config',
      'http://172.16.0.1/x',
      'http://localhost:8080/y',
      'http://[::1]/z',
    ]) {
      await shouldCrawlUrl(url);
      await getCrawlDelay(url);
      await getSitemaps(url);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses odd IPv4 forms browsers accept', async () => {
    await shouldCrawlUrl('http://2130706433/');      // 127.0.0.1 as integer
    await shouldCrawlUrl('http://0x7f000001/');      // hex
    await shouldCrawlUrl('http://017700000001/');    // octal
    expect(fetch).not.toHaveBeenCalled();
  });

  it('still fetches robots.txt for ordinary public sites (direct first)', async () => {
    const allowed = await shouldCrawlUrl('https://public-example.com/page');
    expect(allowed).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const requested = vi.mocked(fetch).mock.calls[0][0] as string;
    expect(requested).toBe('https://public-example.com/robots.txt');
  });

  it('honours Disallow from a fetched robots.txt', async () => {
    vi.stubGlobal('fetch', mockFetchReturning(200, 'User-agent: *\nDisallow: /private\n'));
    expect(await shouldCrawlUrl('https://rules-example.com/private/thing')).toBe(false);
    expect(await shouldCrawlUrl('https://rules-example.com/public/thing')).toBe(true);
  });
});
