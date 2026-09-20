/**
 * Node capability profile — coarse, privacy-minimal self-description used
 * for the network heartbeat. Ported from Indexstr (src/crawler/capabilities.ts)
 * so both node classes report in the same vocabulary.
 *
 * Privacy rules (hard constraints, do not relax):
 *   - no precise location, ever
 *   - no IP as identity
 *   - no fine-grained device fingerprint (model, OS build, screen, fonts…)
 *   - battery rounded to 25% steps, network reduced to a coarse class
 */

export type NodePlatform = 'mobile' | 'desktop' | 'unknown';

export type NetworkClass = 'wifi-or-better' | 'cellular' | 'slow' | 'offline' | 'unknown';

export interface NodeCapabilities {
  /** Coarse platform class — never a model or OS version. */
  platform: NodePlatform;
  /** Coarse network class. */
  network: NetworkClass;
  /** Battery level rounded down to 25% steps; -1 when unknown. */
  batteryQuarter: number;
  charging: boolean;
  /** Protocol version of this node software. */
  nodeVersion: string;
  /** Observation schema this node writes. */
  schema: 'SIP-01';
}

/** Crawlstr node protocol version (bump on heartbeat schema changes). */
export const CRAWLSTR_NODE_VERSION = '2';

let cached: { caps: NodeCapabilities; at: number } | null = null;

/** Battery API is non-standard; keep the local typing contained. */
interface BatteryLike {
  level: number;
  charging: boolean;
}

function detectPlatform(): NodePlatform {
  const ua = navigator.userAgent ?? '';
  if (/Mobi|Android|iPhone|iPad/i.test(ua)) return 'mobile';
  if (ua) return 'desktop';
  return 'unknown';
}

function detectNetwork(): NetworkClass {
  const conn = (navigator as unknown as {
    connection?: { effectiveType?: string; type?: string };
  }).connection;
  if (!conn) return 'unknown';
  if (conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g') return 'slow';
  if (conn.type === 'wifi' || conn.effectiveType === '4g') return 'wifi-or-better';
  if (conn.type === 'cellular' || conn.effectiveType === '3g') return 'cellular';
  if (navigator.onLine === false) return 'offline';
  return 'unknown';
}

/**
 * Read the current capability snapshot. Cached for 60s — capabilities are
 * coarse by design, so freshness matters less than avoiding repeated
 * Battery API calls.
 */
export async function getNodeCapabilities(): Promise<NodeCapabilities> {
  if (cached && Date.now() - cached.at < 60_000) return cached.caps;

  let batteryQuarter = -1;
  let charging = false;
  if ('getBattery' in navigator) {
    try {
      const battery = await (
        navigator as unknown as { getBattery(): Promise<BatteryLike> }
      ).getBattery();
      batteryQuarter = Math.min(4, Math.floor(battery.level * 4)); // 0–4
      charging = battery.charging;
    } catch {
      // Battery API unavailable/blocked — leave as unknown.
    }
  }

  const caps: NodeCapabilities = {
    platform: detectPlatform(),
    network: detectNetwork(),
    batteryQuarter,
    charging,
    nodeVersion: CRAWLSTR_NODE_VERSION,
    schema: 'SIP-01',
  };
  cached = { caps, at: Date.now() };
  return caps;
}
