// IndexedDB is not part of jsdom — fake-indexeddb provides a real
// implementation so the outbox is tested against actual persistence code.
import 'fake-indexeddb/auto';

import { describe, it, expect, beforeEach } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';

import {
  enqueueOutbox,
  getOutboxSize,
  flushOutbox,
  initDB,
} from './queue';
import {
  publishIndexObservation,
  flushObservationOutbox,
  setRelayPublisher,
  getRelayHealth,
  type RelayPublishFn,
} from './publisher';

/**
 * Publish outbox (audit finding #3 / contract C-2): before the fix, a crawl
 * observation published while offline (or against dead relays) was silently
 * dropped, yet the page stayed marked `fetched` — permanent data loss.
 * Now zero-accept events are persisted and flushed when relays recover.
 */

function fakeEvent(id: string): NostrEvent {
  return {
    id,
    kind: 39697,
    pubkey: 'a'.repeat(64),
    sig: 'b'.repeat(128),
    created_at: Math.floor(Date.now() / 1000),
    content: '{"title":"t"}',
    tags: [['d', `widx:${id}`]],
  };
}

async function clearOutbox() {
  const db = await initDB();
  await db.clear('outbox');
}

/** Publisher that rejects every relay. */
const allFail: RelayPublishFn = async (url) => {
  throw new Error(`relay down: ${url}`);
};

describe('observation outbox (queue.ts)', () => {
  beforeEach(clearOutbox);

  it('persists events and reports its size', async () => {
    expect(await getOutboxSize()).toBe(0);
    await enqueueOutbox(fakeEvent('e1'));
    await enqueueOutbox(fakeEvent('e2'));
    expect(await getOutboxSize()).toBe(2);
  });

  it('flush stops at the first failure — nothing is lost on a dead network', async () => {
    await enqueueOutbox(fakeEvent('e1'));
    await enqueueOutbox(fakeEvent('e2'));

    const delivered = await flushOutbox(async () => false);
    expect(delivered).toBe(0);
    expect(await getOutboxSize()).toBe(2); // still held for next time
  });

  it('flush drains in FIFO order and removes only delivered entries', async () => {
    await enqueueOutbox(fakeEvent('e1'));
    await enqueueOutbox(fakeEvent('e2'));
    await enqueueOutbox(fakeEvent('e3'));

    const order: string[] = [];
    const delivered = await flushOutbox(async (event) => {
      order.push(event.id);
      return order.length < 2; // deliver e1, then fail on e2
    });

    expect(delivered).toBe(1);
    expect(order).toEqual(['e1', 'e2']); // e2 attempted, failed, retained
    expect(await getOutboxSize()).toBe(2);

    const rest: string[] = [];
    await flushOutbox(async (event) => {
      rest.push(event.id);
      return true;
    });
    expect(rest).toEqual(['e2', 'e3']);
    expect(await getOutboxSize()).toBe(0);
  });
});

describe('publisher outbox integration (fake relays)', () => {
  beforeEach(clearOutbox);

  it('holds the signed event when zero relays accept, then flushes on recovery', async () => {
    // Phase 1: every relay down.
    setRelayPublisher(allFail);
    const result = await publishIndexObservation({
      url: 'https://example.com/offline-page',
      title: 'Published While Offline',
    });
    expect(result).not.toBeNull();
    expect(result!.delivered).toBe(0);
    expect(result!.normalizedUrl).toBe('https://example.com/offline-page');
    expect(await getOutboxSize()).toBe(1);

    // Relay health recorded the failures.
    const health = getRelayHealth();
    const healthEntries = Object.values(health);
    expect(healthEntries.length).toBeGreaterThan(0);
    expect(healthEntries.every((h) => h.ok === 0 && h.fail > 0)).toBe(true);

    // Phase 2: relays recover — the held event flushes, byte-intact.
    const received: NostrEvent[] = [];
    setRelayPublisher(async (_url, event) => {
      received.push(event);
    });

    const flushed = await flushObservationOutbox();
    expect(flushed).toBe(1);
    expect(await getOutboxSize()).toBe(0);

    // The same signed event (same id/signature) reached every relay.
    expect(received.length).toBeGreaterThan(1);
    const ids = new Set(received.map((e) => e.id));
    expect(ids.size).toBe(1);
    const event = received[0];
    expect(event.kind).toBe(39697);
    expect(event.tags.find(([n]) => n === 'u')?.[1]).toBe('https://example.com/offline-page');
    expect(event.sig).toMatch(/^[0-9a-f]{128}$/);
  });

  it('does not touch the outbox when at least one relay accepts', async () => {
    let calls = 0;
    setRelayPublisher(async (url) => {
      calls++;
      if (!url.includes('ditto')) throw new Error('down'); // one relay up
    });
    const result = await publishIndexObservation({
      url: 'https://example.com/live-page',
      title: 'Published While Online',
    });
    expect(calls).toBeGreaterThan(1);
    expect(result!.delivered).toBe(1);
    expect(await getOutboxSize()).toBe(0);
  });
});
