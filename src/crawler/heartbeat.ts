/**
 * Crawlstr node heartbeat — kind 16919 (replaceable).
 *
 * Ported byte-compatibly from Indexstr (src/crawler/heartbeat.ts), which is
 * the canonical schema; the SIP-01 spec site consumes it read-only for the
 * public dashboard (network health: who's indexing, what shard, coarse
 * platform/network class, counters).
 *
 * A heartbeat says "this scout is alive right now". Published on crawler
 * start and every 10 minutes while running. One replaceable event per node;
 * the latest write wins. Consumers treat heartbeats older than 1 hour as
 * offline.
 *
 * Trust contract: heartbeats are SELF-REPORTED — network health estimates
 * only, never reputation. Reputation derives from signed kind 39697
 * observations (independent, comparable across indexers).
 *
 * Privacy contract: coarse classes only. No location, no IP, no device
 * model, no fine-grained fingerprint.
 */

import { finalizeEvent, type EventTemplate } from 'nostr-tools/pure';
import type { NostrEvent } from '@nostrify/nostrify';
import { getIndexerIdentity, getIndexerSecretKey } from './indexerIdentity';
import { nodeShard, shardLabel } from './sharding';
import { getNodeCapabilities, CRAWLSTR_NODE_VERSION } from './capabilities';

/** Replaceable event kind for crawler node heartbeats. */
export const HEARTBEAT_KIND = 16919;

/** Heartbeats older than this are considered offline (seconds). */
export const HEARTBEAT_TTL_S = 3600;

/** How often a running node re-publishes its heartbeat. */
export const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000;

export interface HeartbeatStats {
  pagesIndexed: number;
  queueSize: number;
  published: number;
}

export interface HeartbeatPayload {
  v: string;
  shard: string;
  platform: string;
  network: string;
  charging: boolean;
  stats: HeartbeatStats;
}

export interface ParsedHeartbeat extends HeartbeatPayload {
  pubkey: string;
  createdAt: number;
  source?: string;
}

/** Build and sign this node's heartbeat. */
export async function buildHeartbeat(stats: HeartbeatStats): Promise<NostrEvent> {
  const identity = getIndexerIdentity();
  const caps = await getNodeCapabilities();
  const shard = nodeShard(identity.pubkeyHex);

  const payload: HeartbeatPayload = {
    v: CRAWLSTR_NODE_VERSION,
    shard: shardLabel(shard),
    platform: caps.platform,
    network: caps.network,
    charging: caps.charging,
    stats,
  };

  const template: EventTemplate = {
    kind: HEARTBEAT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    content: JSON.stringify(payload),
    tags: [
      ['v', CRAWLSTR_NODE_VERSION],
      ['shard', shardLabel(shard)],
      ['source', 'crawlstr/v2'],
      ['alt', `Crawlstr node heartbeat: shard ${shardLabel(shard)}`],
    ],
  };

  return finalizeEvent(template, getIndexerSecretKey());
}

/** Structural validation for incoming heartbeats (indexstr-compatible). */
export function parseHeartbeat(event: NostrEvent): ParsedHeartbeat | null {
  if (event.kind !== HEARTBEAT_KIND) return null;
  try {
    const payload = JSON.parse(event.content) as Partial<HeartbeatPayload>;
    const shard = payload.shard;
    if (typeof shard !== 'string' || !/^[0-9A-Fa-f]{2}$/.test(shard)) return null;
    if (typeof payload.v !== 'string') return null;
    return {
      pubkey: event.pubkey,
      createdAt: event.created_at,
      v: payload.v,
      shard: shard.toUpperCase(),
      platform: typeof payload.platform === 'string' ? payload.platform.slice(0, 16) : 'unknown',
      network: typeof payload.network === 'string' ? payload.network.slice(0, 24) : 'unknown',
      charging: payload.charging === true,
      stats: {
        pagesIndexed: Math.max(0, Number(payload.stats?.pagesIndexed) || 0),
        queueSize: Math.max(0, Number(payload.stats?.queueSize) || 0),
        published: Math.max(0, Number(payload.stats?.published) || 0),
      },
      source: event.tags.find(([n]) => n === 'source')?.[1],
    };
  } catch {
    return null;
  }
}

/** Latest heartbeat per node pubkey (kind 16919 is replaceable). */
export function dedupeHeartbeats(events: NostrEvent[]): ParsedHeartbeat[] {
  const latest = new Map<string, ParsedHeartbeat>();
  for (const event of events) {
    const hb = parseHeartbeat(event);
    if (!hb) continue;
    const prev = latest.get(hb.pubkey);
    if (!prev || hb.createdAt > prev.createdAt) latest.set(hb.pubkey, hb);
  }
  return [...latest.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/** True when the heartbeat is fresh enough to count the node as online. */
export function isNodeLive(
  hb: ParsedHeartbeat,
  now = Math.floor(Date.now() / 1000),
): boolean {
  return now - hb.createdAt <= HEARTBEAT_TTL_S;
}
