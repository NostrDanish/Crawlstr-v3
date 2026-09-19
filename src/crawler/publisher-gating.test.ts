// Separate file from publisher.test.ts: relay health is module-level state,
// and this test needs every relay to start with a clean ok/fail record
// (vitest isolates module state per test file).
import 'fake-indexeddb/auto';

import { describe, it, expect } from 'vitest';

import { initDB, getOutboxSize } from './queue';
import { publishIndexObservation, setRelayPublisher, getRelayHealth } from './publisher';

describe('relay health gating (publisher.ts)', () => {
  it('gates a relay after 8 failures with no success; one success re-enables', async () => {
    const db = await initDB();
    await db.clear('outbox');

    const attempts = new Map<string, number>();
    setRelayPublisher(async (url) => {
      attempts.set(url, (attempts.get(url) ?? 0) + 1);
      throw new Error('always down');
    });

    const publish = (i: number) =>
      publishIndexObservation({ url: `https://example.com/gated-${i}`, title: `Gated ${i}` });

    // Eight all-fail publishes → every relay reaches RELAY_FAIL_GATE.
    for (let i = 0; i < 8; i++) await publish(i);
    const health = getRelayHealth();
    expect(Object.values(health).every((h) => h.ok === 0 && h.fail === 8)).toBe(true);

    // Ninth publish: all relays gated — zero attempts, event straight to outbox.
    const outboxBefore = await getOutboxSize();
    const result = await publish(8);
    for (const count of attempts.values()) expect(count).toBe(8);
    expect(result!.delivered).toBe(0);
    expect(await getOutboxSize()).toBe(outboxBefore + 1);

    // A relay with a success on record is never gated.
    expect(Object.values(getRelayHealth()).every((h) => h.ok === 0)).toBe(true);
  });
});
