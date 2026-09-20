// Separate file: relay health is module-level state, and these tests need a
// clean ok/fail record (vitest isolates module state per test file).
import 'fake-indexeddb/auto';

import { describe, it, expect } from 'vitest';

import { publishIndexObservation, publishHeartbeatEvent, setRelayPublisher, getRelayHealth } from './publisher';
import { getHeartbeatRelays, getIndexPublishRelays, SIP01_RELAYS } from './relays';

/**
 * Heartbeat relay set (kind 16919). The SIP-01-validating relays only accept
 * kind 39697 ("blocked: event kind 16919 not allowed on this relay") and
 * search.nos.today is read-only ("blocked: writes disabled") — pushing
 * heartbeats at the full observation set just burns rate limits (damus
 * escalated to "banned" in the field) and spams the console.
 */
describe('heartbeat relay set (kind 16919)', () => {
  it('never includes the SIP-01-validating relays, read-only search relays, or the .onion relay', () => {
    const heartbeat = getHeartbeatRelays();
    // The full observation set for contrast.
    const observations = getIndexPublishRelays();

    for (const sip of SIP01_RELAYS) {
      expect(heartbeat).not.toContain(sip);
      expect(observations).toContain(sip);
    }
    expect(heartbeat).not.toContain('wss://search.nos.today/');
    expect(heartbeat.some((u) => u.includes('.onion'))).toBe(false);
    // Heartbeats DO reach general write relays.
    expect(heartbeat).toContain('wss://relay.ditto.pub/');
    expect(heartbeat).toContain('wss://relay.damus.io/');
    // And the observation set still carries everything.
    expect(observations.length).toBeGreaterThan(heartbeat.length);
  });

  it('publishes heartbeats only to the heartbeat set', async () => {
    const attempted: string[] = [];
    setRelayPublisher(async (url) => {
      attempted.push(url);
    });

    const fakeHeartbeat = {
      id: 'c'.repeat(64),
      kind: 16919,
      pubkey: 'a'.repeat(64),
      sig: 'b'.repeat(128),
      created_at: Math.floor(Date.now() / 1000),
      content: '{}',
      tags: [],
    };
    await publishHeartbeatEvent(fakeHeartbeat);

    const heartbeat = getHeartbeatRelays();
    expect(attempted.length).toBe(heartbeat.length);
    for (const url of attempted) {
      expect(heartbeat).toContain(url);
      expect(url).not.toMatch(/sip-01|uncaged-sip|metanomalist|nos\.today|onion/);
    }
  });
});

describe('policy rejection gating', () => {
  it('a relay that refuses by policy is skipped immediately (no 8-failure wait)', async () => {
    let policyRelayAttempts = 0;
    setRelayPublisher(async (url) => {
      if (url.includes('sip-01test')) {
        policyRelayAttempts++;
        throw new Error('blocked: event kind 39697 not allowed on this relay');
      }
    });

    // First publish: policy rejection recorded.
    await publishIndexObservation({ url: 'https://example.com/policy-1', title: 'Policy 1' });
    const health = getRelayHealth();
    const entry = Object.entries(health).find(([url]) => url.includes('sip-01test'));
    expect(entry).toBeDefined();
    expect(entry![1].policyBlocked).toBe(true);

    // Second publish: the policy-blocked relay gets ZERO new attempts.
    const before = policyRelayAttempts;
    await publishIndexObservation({ url: 'https://example.com/policy-2', title: 'Policy 2' });
    expect(policyRelayAttempts).toBe(before);
  });
});
