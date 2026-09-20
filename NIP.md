# Crawlstr — Event Kinds & Protocol Reference

Crawlstr is a **browser-based web crawler** that publishes to the **shared SIP-01
(Search Index Protocol) index** on Nostr. It implements the **canonical SIP-01
specification v1.2** — [github.com/NostrDanish/SIP-01](https://github.com/NostrDanish/SIP-01)
(`public/spec/SIP-01.md`) — byte-compatibly with
[0xSearchstr](https://github.com/NostrDanish/0xSearchstr),
[0xPresearchstr](https://github.com/NostrDanish/0xPresearchstr),
[UNCAGED-ENGINE](https://github.com/NostrDanish/UNCAGED-ENGINE), and the
[UNCAGED Index Relay](https://github.com/NostrDanish/UNCAGED-Index-Relay).

> **v1.2 note:** that revision audited NIP references and added the §20
> dependency table. The wire format is unchanged — schema `v` stays `"1"`, and
> every v1/v1.1 event remains valid. Of the v1.2 changes, the ones that touch
> us: addressable-kind semantics are now cited from NIP-01 (NIP-33 was folded
> in), and the `l` tag convention is NIP-32's, used here in the bare two-letter
> form per §12.5 — which is exactly what we emit.

## Protocol Compatibility

| Schema | Kind | Type | Status |
|--------|------|------|--------|
| Web Index Observation (SIP-01) | **39697** | addressable | **Written** by Crawlstr |
| Crawler node heartbeat | **16919** | replaceable | **Written** by Crawlstr |

Crawlstr is a **pure SIP-01 publisher** for observations — it does NOT write
community submissions (kind 30078) or query caches. Kind 16919 is the shared
crawler-network health event (schema: Indexstr's
[`src/crawler/heartbeat.ts`](https://github.com/NostrDanish/indxestr/blob/main/src/crawler/heartbeat.ts),
consumed read-only by the [SIP-01 site](https://github.com/NostrDanish/SIP-01)
dashboard) — documented below.

## Kind 16919 — Crawler Node Heartbeat

A replaceable event (latest per pubkey) announcing *"this scout is alive and
indexing."* Published on crawler start and every 10 minutes while running.
Consumers treat heartbeats older than **1 hour** as offline.

```json
{
  "kind": 16919,
  "pubkey": "<device indexer pubkey>",
  "created_at": 1786250000,
  "content": "{\"v\":\"2\",\"shard\":\"C4\",\"platform\":\"desktop\",\"network\":\"wifi-or-better\",\"charging\":true,\"stats\":{\"pagesIndexed\":1204,\"queueSize\":183,\"published\":1198}}",
  "tags": [
    ["v", "2"],
    ["shard", "C4"],
    ["source", "crawlstr/v2"],
    ["alt", "Crawlstr node heartbeat: shard C4"]
  ]
}
```

**Tags:** `v` (node protocol version — `"2"` for Crawlstr v2 nodes), `shard`
(home shard, two uppercase hex chars — first byte of the indexer pubkey),
`source` (`crawlstr/v2`), `alt` (human-readable).

**Content** (JSON): `v`, `shard`, coarse `platform` (`mobile`/`desktop`),
coarse `network` class, `charging`, and self-reported `stats`
(`pagesIndexed`, `queueSize`, `published` — the last counts only
relay-**acked** observations, never merely-built ones).

**Privacy contract:** no location, no IP, no device model, no fine-grained
fingerprint. Battery/network are deliberately coarse classes.

**Trust contract:** heartbeats are *self-reported* — usable for network
health/coverage estimates only. Reputation is derived from signed kind 39697
observations (independent and comparable across indexers), never from
heartbeat claims.

**Sharding:** the URL→shard map is FNV-1a over the SIP-01-normalized URL
(`fnv1a32(url) >> 24`, 256 shards), ported byte-compatibly from Indexstr so
both node classes compute the same assignment. Crawlstr only uses it for the
heartbeat's home-shard field — Indexstr does the actual preferential
scheduling.

## What Crawlstr Writes

### Kind 39697 — Web Index Observation (SIP-01)

One addressable event per `(crawler's indexer pubkey, normalized URL)` — a signed
statement: *"This device observed this web page at this time, and here is its
public metadata."*

```json
{
  "kind": 39697,
  "pubkey": "<device indexer pubkey, hex>",
  "created_at": 1786250000,
  "content": "{\"title\":\"Example Page\",\"description\":\"A page about...\",\"image\":\"https://example.com/og.jpg\"}",
  "tags": [
    ["d", "widx:9f86d081884c7d659a2feaa0c55ad015"],
    ["u", "https://example.com/page"],
    ["l", "en"],
    ["x", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["v", "1"],
    ["published", "1786200000"],
    ["source", "crawlstr/v2"],
    ["network", "clearnet"],
    ["type", "page"],
    ["alt", "Web index observation: Example Page"]
  ]
}
```

**Core tags (spec §5/§6):**

| Tag | Required | Meaning |
|-----|----------|---------|
| `d` | ✔ | `"widx:" + sha256(normalized_url)[0:32]` — URL identity, identical across all indexers |
| `u` | ✔ | Canonical URL (http/https only, ≤ 2048 chars, normalized per SIP-01 §7) |
| `v` | ✔ | Schema version `"1"` |
| `x` | ✔ | Content hash: `sha256(title + "\n" + description)` (§8) |
| `alt` | ✔ | Human-readable summary (the `alt` convention; spec §12.3) |
| `l` | – | ISO 639-1 language code, bare two-letter form (§12.5; convention from NIP-32) |
| `t` | – | 0–8 lowercase topic tags matching `^[a-z0-9][a-z0-9-]{0,99}$` |
| `published` | – | Unix seconds — page's claimed publication time (§12.2) |
| `source` | – | `"crawlstr/v2"` — identifies this software (≤ 100 chars); v1 nodes emitted `crawlstr/1` and remain valid |

**Extension tags (spec §9.2 registry):**

| Tag | Value | Meaning |
|-----|-------|---------|
| `network` | always `clearnet` | A browser crawler can only reach the clearnet |
| `type` | `page` / `repository` | `repository` for GitHub/GitLab hosts, else `page` |
| `platform` | e.g. `github`, `youtube`, `wikipedia` | Emitted for well-known hosts only |

**Key properties (same as all SIP-01 publishers):**

- **Per-device indexer identity** — each browser generates its own anonymous keypair
  on first use (`localStorage: sip:indexer:secret`). Never the user's personal key (§14).
- **No query leakage** — the event contains a URL and public page metadata, never
  what anyone searched for (§16).
- **URL normalization** — identical to SIP-01 §7: strips tracking params, lowercases
  scheme/host, removes `www.`, sorts query params, removes fragments. Verified
  byte-identical against the §13 test vectors.
- **Deduplication** — the `d` tag is deterministic from the normalized URL; the
  `x` tag is a content agreement signal. Multiple crawlers observing the same page
  produce events with the same `d` — search nodes count distinct authors.
- **Addressable** — re-crawling the same URL replaces the previous observation
  (one slot per indexer per URL).

### Publisher behavior: adaptive freshness recrawls (v2)

Crawlstr v2 nodes keep an index, not a snapshot. Every successfully crawled
URL is **revisited on a change-detected schedule** and the observation is
**republished** with a fresh `created_at`:

- first crawl → recrawl in **24h**;
- recrawl, content changed (local text hash differs) → back to **24h**;
- recrawl, content unchanged → interval **doubles** (2d, 4d, 8d … capped at **30d**).

Consumers should read a fresh `created_at` with the same `d` from the same
indexer as a **liveness signal** ("this page is still alive and says the same
thing"), not as spam. Because kind 39697 is addressable, the republish costs
the network one replace per `(pubkey, d)` slot — bounded by construction.

Related publisher-side behaviors that never change the wire format:

- **Negative cache** — permanent fetch failures (4xx, non-HTML, oversize,
  SSRF refusal) are remembered locally for 7 days instead of being retried;
  no events are involved.
- **Crawl-trap guards** — session-state URLs, filter-combination generators
  and infinite path spaces are refused at the queue gate (500 URLs/domain cap
  for discovered links); seeds are the human's explicit choice and bypass
  the guards.

## How Crawlstr Differs from Other SIP-01 Publishers

| Feature | 0xSearchstr / UNCAGED | Crawlstr |
|---------|----------------------|----------|
| **Trigger** | Search results surfaced by providers | Active web crawling |
| **Discovery** | Search results from external APIs | Link following from seed URLs |
| **Depth** | 1 (direct results only) | Configurable (up to 3 by default) |
| **Rate limiting** | N/A (API-driven) | Per-domain, configurable |
| **robots.txt** | N/A | Respected (configurable) |
| **Queue** | N/A | IndexedDB persistent queue |
| **Power management** | N/A | Battery/WiFi/bandwidth aware |

The **event schema is identical**. The difference is only in how URLs are discovered.

## Relay Publishing

Crawlstr publishes to the same relay pool as the ecosystem:

**Search relays (NIP-50):**
- `wss://relay.nostr.band/`
- `wss://relay.ditto.pub/`
- `wss://search.nos.today/`
- `wss://relay.noswhere.com/`

**Write relays (for propagation):**
- `wss://relay.ditto.pub/`
- `wss://relay.primal.net/`
- `wss://relay.damus.io/`

**Observations (kind 39697)** go to the full set above (SIP-01 relays +
search pool + write relays + user customs). **Heartbeats (kind 16919)** go
to a deliberately small general-write subset (`relay.ditto.pub`,
`jskitty.cat`, `relay.primal.net`, `relay.damus.io`, `nostr.hifish.org`) —
the SIP-01-validating relays only accept kind 39697, and read-only relays
refuse everything, so heartbeats never target them. Relays that refuse by
*policy* (`not allowed`, `writes disabled`, `blocked`) are recorded in the
per-relay health map and skipped immediately instead of being retried.

## Reading the Index

Any SIP-01 compatible search engine can read Crawlstr's observations:

```json
{
  "kinds": [39697],
  "#d": ["widx:9f86d081884c7d659a2feaa0c55ad015"]
}
```

Or browse by topic:

```json
{
  "kinds": [39697],
  "#t": ["nostr"],
  "limit": 50
}
```

Or query full-text via NIP-50 on SIP-01-aware relays, using the web-search
operators from spec §15 (`site:`, `title:`, `lang:`, `after:`, …):

```json
{
  "kinds": [39697],
  "search": "bitcoin privacy site:nostr.com lang:en after:2026-01-01",
  "limit": 20
}
```

## Trust Model

- Crawlstr observations are **structurally trusted** — any indexer pubkey is accepted.
- Events are validated on parse: schema version, URL allowlist, field caps.
- Agreement across independent indexers (same `d`, different `pubkey`) is the
  ranking signal.
- Crawlstr is just one more independent indexer in the SIP-01 ecosystem.

## References

- **Canonical spec (v1.1):** [NostrDanish/SIP-01](https://github.com/NostrDanish/SIP-01) — `public/spec/SIP-01.md`
- **Implementation guide:** [SIP-01/docs/IMPLEMENTATION-GUIDE.md](https://github.com/NostrDanish/SIP-01/blob/main/docs/IMPLEMENTATION-GUIDE.md)
- **Reference port:** [SIP-01/src/lib/sip01-utils.ts](https://github.com/NostrDanish/SIP-01/blob/main/src/lib/sip01-utils.ts)
- **0xSearchstr NIP.md:** [legacy schemas, community submissions, Nostra interop](https://github.com/NostrDanish/0xSearchstr/blob/main/NIP.md)
- **UNCAGED-ENGINE NIP.md:** [reference implementation schemas](https://github.com/NostrDanish/UNCAGED-ENGINE/blob/main/NIP.md)
- **UNCAGED Index Relay:** [validating relay profile](https://github.com/NostrDanish/UNCAGED-Index-Relay)
