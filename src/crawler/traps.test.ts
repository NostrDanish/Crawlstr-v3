import { describe, it, expect } from 'vitest';
import { isLikelyCrawlTrap, DomainIntakeGuard } from './traps';

describe('isLikelyCrawlTrap', () => {
  it('passes ordinary content URLs', () => {
    expect(isLikelyCrawlTrap('https://example.com/about')).toBe(false);
    expect(isLikelyCrawlTrap('https://blog.example.com/2026/09/hello-world')).toBe(false);
    expect(isLikelyCrawlTrap('https://shop.example.com/item?id=42&color=red')).toBe(false);
  });

  it('blocks session-state query keys', () => {
    expect(isLikelyCrawlTrap('https://example.com/page?phpsessid=abc123')).toBe(true);
    expect(isLikelyCrawlTrap('https://example.com/page?sid=xyz')).toBe(true);
    expect(isLikelyCrawlTrap('https://example.com/page?JSSESSIONID=xyz')).toBe(true);
  });

  it('blocks filter-combination generators (>6 query params)', () => {
    const url =
      'https://example.com/search?a=1&b=2&c=3&d=4&e=5&f=6&g=7';
    expect(isLikelyCrawlTrap(url)).toBe(true);
  });

  it('blocks trap path segments', () => {
    expect(isLikelyCrawlTrap('https://example.com/calendar/2026/09')).toBe(true);
    expect(isLikelyCrawlTrap('https://example.com/shop/checkout')).toBe(true);
  });

  it('blocks repeating path segments (generator loops)', () => {
    expect(isLikelyCrawlTrap('https://example.com/a/b/a/b/a')).toBe(true);
    expect(isLikelyCrawlTrap('https://example.com/x/y/z')).toBe(false);
  });

  it('blocks very long numeric segments (counter space)', () => {
    expect(isLikelyCrawlTrap('https://example.com/doc/123456789')).toBe(true);
    expect(isLikelyCrawlTrap('https://example.com/doc/12345678')).toBe(false);
  });

  it('blocks extreme depth', () => {
    expect(isLikelyCrawlTrap('https://example.com/1/2/3/4/5/6/7/8/9')).toBe(true);
    expect(isLikelyCrawlTrap('https://example.com/1/2/3/4/5/6/7/8')).toBe(false);
  });

  it('fails closed on unparseable input', () => {
    expect(isLikelyCrawlTrap('not a url')).toBe(true);
  });
});

describe('DomainIntakeGuard', () => {
  it('allows up to the cap, then refuses', () => {
    const guard = new DomainIntakeGuard(3);
    expect(guard.allow('https://a.example/1')).toBe(true);
    expect(guard.allow('https://a.example/2')).toBe(true);
    expect(guard.allow('https://a.example/3')).toBe(true);
    expect(guard.allow('https://a.example/4')).toBe(false);

    // A different domain has its own budget.
    expect(guard.allow('https://b.example/1')).toBe(true);
  });

  it('refuses unparseable URLs', () => {
    const guard = new DomainIntakeGuard(10);
    expect(guard.allow('not a url')).toBe(false);
  });
});
