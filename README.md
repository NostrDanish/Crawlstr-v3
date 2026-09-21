# Crawlstr v3

<p align="center">
  <img src="public/brand/logo.png" alt="Crawlstr — a spider sitting in its web" width="192" height="192">
</p>

**Decentralized browser-based web crawler.** Turn your browser into a voluntary crawl node that feeds the shared [SIP-01](https://github.com/NostrDanish/SIP-01) index on Nostr — the canonical [Search Index Protocol v1.2](https://github.com/NostrDanish/SIP-01/blob/main/public/spec/SIP-01.md). No backend. No tracking. No accounts required.

Every page you crawl becomes a **kind 39697 web index observation** — instantly searchable by [0xSearchstr](https://0xsearchstr.shakespeare.wtf), [0xPresearchstr](https://presearchstr.shakespeare.wtf), [UNCAGED](https://uncaged.shakespeare.wtf), and any future SIP-01 compatible client. Crawlstr v3 then **keeps those pages alive**: adaptive recrawls re-visit every URL on a change-detected schedule (24h → 30d) and republish the freshness signal.

**Live:** [https://crawlstr.shakespeare.wtf](https://crawlstr.shakespeare.wtf)

[![Edit with Shakespeare](https://shakespeare.diy/badge.svg)](https://shakespeare.diy/clone?url=https%3A%2F%2Fgithub.com%2FNostrDanish%2FCrwalstr.git)

---

## How It Works

```
You add a seed URL
       │
       ▼
┌─────────────┐
│   Crawler   │  IndexedDB queue, persistent across sessions
│   Engine    │  Battery/WiFi/bandwidth aware
└──────┬──────┘
       │
       ▼
   Fetch page (respects robots.txt, rate-limited per domain)
       │
       ▼
   Parse HTML (title, description, text, links, language)
       │
       ▼
   SHA-256 content hash (dedup across the network)
       │
       ▼
   Sign kind 39697 event with per-device indexer key
       │
       ▼
   Publish to Nostr relays (SIP-01)
       │
       ▼
┌──────────────────────────────────────┐
│        Shared SIP-01 Index           │
│                                      │
│  0xSearchstr reads it                │
│  0xPresearchstr reads it             │
│  UNCAGED reads it                    │
│  Your fork reads it                  │
│  Any SIP-01 client reads it          │
└──────────────────────────────────────┘
```

---

## What Makes This Different

Most "decentralized search" projects still run centralized crawlers. Crawlstr makes **every browser a potential crawler** — opt-in, transparent, resource-aware.

| Feature | Description |
|---------|-------------|
| **Opt-in only** | Nothing runs without explicitly pressing "Start Crawling" |
| **🎲 Random Scout** | One button — queues 5 fresh curated corners and keeps scouting until you stop it |
| **SIP-01 native** | Same protocol as 0xSearchstr, 0xPresearchstr, UNCAGED — one shared index |
| **Adaptive recrawls** | Every page is revisited on a change-detected schedule (24h → 30d) and republished — the network's freshness signal |
| **Per-device identity** | Anonymous indexer keypair, separate from your Nostr identity |
| **No query leakage** | Events contain page metadata only — never what anyone searched for |
| **Resource aware** | Battery, WiFi, bandwidth limits. Eco mode. Charging-only mode. |
| **robots.txt** | Respected by default (configurable) |
| **Rate limited** | 5–8 seconds between requests per domain, ≤1 request in flight per domain |
| **Parallel politeness slots** | 2 slot runners over one scheduler — more domain diversity, same per-site rate |
| **Crawl-trap guards** | Session-state URLs, filter generators and infinite path spaces are refused at the queue gate |
| **Negative cache** | Permanent failures (4xx, non-HTML, oversize) are remembered for 7 days, not retried forever |
| **Persistent queue** | IndexedDB-backed, survives browser restarts |
| **Offline capable** | Zero-ack observations are held in an IndexedDB outbox and flushed when relays are reachable |
| **Acked-only accounting** | "Published" counts relay-ACKed events — never merely-built ones |
| **Network heartbeat** | Kind 16919 — visible on the SIP-01 dashboard while running |
| **PWA** | Installable, works on mobile and desktop |

---

## What's New in v3

Crawlstr v3 keeps the v2 machinery and hardens the node. Same SIP-01 wire
format (`v` stays `"1"`, kind 39697, byte-compatible `d`/`x`) — v3 changes
*behavior*, not the protocol. Observations are tagged `source=crawlstr/v3`.

| | v2 | v3 (this) |
|---|---|---|
| **Crawl modes** | Several modes to configure | One-button **Random Scout**: queues 5 fresh curated seed bundles and keeps scouting until you stop it |
| **Dispatch** | `noteRequest()` ran before `tryAcquire()` — every job stamped its own domain "just requested", failed its acquire, and re-stamped on every retry: infinite self-deferral, 0 pages/hour | robots.txt warm-up is a **scheduled request on the domain lane** (acquire → warm → release); page dispatch is a pure `tryAcquire` — regression-tested |
| **robots.txt unreachable** | Null result was never cached — the domain would warm-loop forever | Fail-open per the documented policy: empty rules are cached, the page proceeds |
| **Trap defense** | Session keys, query complexity, 3-in-a-row segment repeats | Adds **period-2 generator loops** (`/a/b/a/b/a` — calendar/facet generators) and the `JSSESSIONID` session-key variant |
| **Retry backoff** | Jitter applied after the cap — a 1-hour sleep could inflate to 72 min | Cap applied **after** jitter — no retry ever waits longer than 1 hour |
| **Abort handling** | `waitForWake`/`sleep` hung until the timeout when stop fired mid-entry | Already-aborted signals resolve immediately — instant, clean shutdown |
| **Heartbeat privacy** | Raw counters (`pagesIndexed`, `queueSize`, `published`) left the device | Counters coarsened to two significant figures before signing (indexstr F14) — exact totals never leave the device |

Source-tag history: v1 nodes emit `crawlstr/1`, v2 nodes emit `crawlstr/v2`,
v3 nodes emit `crawlstr/v3`. All remain valid SIP-01; dashboards can tell the
traffic apart.

## What's New in v2

Crawlstr v2 keeps the v1 scout philosophy and adds the machinery the v1 index
was missing. Everything speaks the same SIP-01 wire format (`v` stays `"1"`,
kind 39697, byte-compatible `d`/`x`) — v2 changes *behavior*, not the
protocol. Observations are tagged `source=crawlstr/v2`.

| | v1 | v2 (this) |
|---|---|---|
| **Recrawls** | Never — `isFetched()` blocked a URL forever, the index went stale | Adaptive freshness schedule: changed → 24h, unchanged → doubles to 30d; republishes the liveness signal |
| **Fetch failures** | 3 flat retries, then dropped *and forgotten* (re-fetched next discovery) | Classified permanent vs transient; transient get bounded exponential backoff; permanent are negative-cached for 7 days |
| **Crawl loop** | One serial loop, fixed sleeps | Event-driven, 2 parallel slot runners over a per-domain scheduler; computed sleeps, wake on admission |
| **Trap defense** | A regex over a few path words | Session keys, query complexity, repeating segments, 9+ digit counters, depth >8, plus a 500-URL/domain intake cap |
| **Duplicate content** | Dropped entirely — re-fetched on every rediscovery | Recorded (never re-fetched) and still published — the URL's `d` identity with a matching `x` is exactly the §8 agreement signal |
| **Body reads** | Buffered whole (`response.text()`), bytes metered after the fact | Stream-capped at the size limit with real-byte metering — no multi-MB main-thread allocations |
| **Published stat** | Pages built (lied when the network was down) | Relay-ACKed only; zero-ack events land in the IndexedDB outbox |
| **Job claiming** | Read-then-remove (double-crawl race possible) | Atomic claim inside one IndexedDB transaction |

Source-tag history: v1 nodes emit `crawlstr/1`, v2 nodes emit `crawlstr/v2`.
Both remain valid SIP-01; dashboards can tell the traffic apart.

---

## The Scout / Indexer Split

Crawlstr is deliberately **not** a small copy of [Indexstr](https://github.com/NostrDanish/indxestr). They're two classes of node:

```
        THE INDEXSTR NETWORK
                  │
    ┌─────────────┴─────────────┐
    │                           │
🪶 CRAWLSTR                🏭 INDEXSTR
Lightweight scout          Heavyweight indexer
"I found something"        "I operate indexing capacity"
    │                           │
    └─────────────┬─────────────┘
                  ▼
              NOSTR / SIP-01
                  │
    ┌─────────────┼─────────────┐
    ▼             ▼             ▼
0xSearchstr   UNCAGED      Other engines
```

| | 🪶 Crawlstr (this) | 🏭 Indexstr |
|---|---|---|
| **Role** | Human-directed & random discovery | Systematic distributed crawling |
| **Seeds** | You paste a URL, or Random Scout picks | Bundled curated SQLite collections |
| **Queue** | Small, session-scoped | Massive, sharded across 256 slots |
| **Discovery** | Links, feeds, sitemaps, canonical | Collection URLs at scale |
| **Device** | Any browser, incl. a phone on WiFi | Desktop/VPS-class contribution |
| **Coupling** | None. Both speak SIP-01 to Nostr. | None. Both speak SIP-01 to Nostr. |

Crawlstr finds. Indexstr maintains. Nostr distributes. Searchstr searches.

---

## Quick Start

```bash
git clone https://github.com/NostrDanish/Crwalstr.git
cd Crwalstr
npm install
npm run dev
```

Open the printed URL, add a seed URL, press **Start Crawling**.

---

## Usage

### Random Scout

The fastest way to contribute: press **Explore a random corner of the web** and Crawlstr shows you a starting point — its category and URL — before anything happens. **Scout This** starts the crawl; **Another** reshuffles. No account, no configuration, no URL needed.

Selection history stays in your browser (localStorage) and is **never published** — only the resulting page observations go to Nostr.

#### The seed corpus

The corpus lives in `src/data/seeds/*.txt` — **one category per plain-text file**, so improving the dataset never means touching crawler logic:

```
src/data/seeds/
├── nostr.txt      ← Nostr ecosystem
├── bitcoin.txt    ← Bitcoin & open money
├── dev.txt        ← Dev resources & awesome lists
├── science.txt    ← Science & education
├── books.txt      ← Books, archives & libraries
├── music.txt      ← Music, art & culture
├── games.txt      ← Games
├── opendata.txt   ← Open data & internet infrastructure
└── indie.txt      ← Indie blogs & the small web
```

#### How a seed is picked

Not plain `Math.random()` over a flat list. Each pick rolls a weighted strategy, tuned for **long-tail coverage**:

| Weight | Strategy | Picks from |
|--------|----------|------------|
| 40% | **Fresh** | Seeds this device has never scouted |
| 25% | **Rare** | Seeds this device has scouted least often |
| 15% | **Category** | The category this device has explored least |
| 10% | **Stale** | Seeds not scouted for the longest time |
| 10% | **Random** | Pure randomness |

The selection commits to history when a bundle is queued — a seed is only "scouted" once the crawl actually starts.

### Seed a URL

Enter any URL in the **Seed URLs** tab:

```
https://bitcoin.org
```

The crawler fetches the page, extracts content, hashes it, signs a SIP-01 observation, and publishes to Nostr. Then it follows links up to depth 3.

### How It Runs

v2 removed crawl modes — one behaviour, no budgets: **the scout runs until you stop it.** Every resource limit (pages/hour, bandwidth, battery, WiFi, robots.txt, per-domain rate) still applies the whole time.

### Random Scout — one button

The main control is a single toggle:

1. **Press** → 5 distinct random seeds are picked from the curated corpus (weighted toward fresh/rare corners), queued at once, and crawling starts.
2. **It keeps going** — when the queue drains, a fresh bundle of 5 is picked automatically, so the scout wanders from corner to corner until you shut it off.
3. **Press again** → stops cleanly. **Press once more** → a fresh bundle, a new run.

A bundle (not a single seed) gives the crawl immediate domain diversity and a fallback: if one corner is unreachable, thin, or robots-blocked, the other four still carry the session. Selection history stays in your browser (localStorage) and is **never published** — only the resulting page observations go to Nostr.

### Discovery Sources

Crawlstr is a **scout**, so it prioritizes cheap, high-value discovery over bulk fetching:

- **RSS/Atom feeds** — one small XML file yields current content URLs with titles and dates; entries are indexed directly and queued for full fetches
- **Sitemaps** — `Sitemap:` declarations in robots.txt, plus `/sitemap.xml`; sampled and bounded, never a firehose
- **Canonical URLs** — observations are filed under the page's claimed canonical identity
- **Link graph** — same-domain links followed with per-domain rate limits; login/cart/calendar traps filtered out

### Crawler Settings

| Setting | Default | Description |
|---------|---------|-------------|
| **WiFi Only** | Off | Only crawl on WiFi networks |
| **Charging Only** | Off | Only crawl while device is charging |
| **Respect robots.txt** | On | Follow website crawling policies |
| **Eco Mode** | On | Slower crawling, less resource usage |
| **Follow RSS/Atom feeds** | On | Index feed entries (cheap discovery) |
| **Read sitemaps** | On | Use sitemap.xml for discovery (sampled) |

### Indexer Identity

Each browser gets its own anonymous indexer keypair (visible in the dashboard). This key signs all kind 39697 observations. It is:

- **Pseudonymous** — not linked to your personal Nostr identity
- **Replaceable** — regenerating creates a new indexer
- **Local** — the secret key never leaves your browser
- **Exportable** — for backup or migration

---

## Protocol

Crawlstr publishes **SIP-01 (Search Index Protocol)** events — the same protocol used by the entire Searchstr ecosystem.

### Kind 39697 — Web Index Observation

```json
{
  "kind": 39697,
  "pubkey": "<device indexer pubkey>",
  "created_at": 1786250000,
  "content": "{\"title\":\"Example Page\",\"description\":\"A page about...\"}",
  "tags": [
    ["d", "widx:9f86d081884c7d659a2feaa0c55ad015"],
    ["u", "https://example.com/page"],
    ["l", "en"],
    ["x", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["v", "1"],
    ["source", "crawlstr/v3"],
    ["network", "clearnet"],
    ["type", "page"],
    ["alt", "Web index observation: Example Page"]
  ]
}
```

| Tag | Meaning |
|-----|---------|
| `d` | `"widx:" + sha256(normalized_url)[0:32]` — URL identity, identical across all indexers |
| `u` | Canonical URL (normalized per SIP-01 §7) |
| `x` | Content hash: `sha256(title + "\n" + description)` |
| `v` | Schema version `"1"` |
| `l` | ISO 639-1 language code |
| `source` | `"crawlstr/v3"` (v2 nodes: `"crawlstr/v2"`, v1 nodes: `"crawlstr/1"`) |
| `network` | Extension registry (§9.2) — always `clearnet` for a browser crawler |
| `type` | Extension registry — `repository` for GitHub/GitLab, else `page` |
| `alt` | Human-readable description (the `alt` convention, spec §12.3) |

Full schema documentation: [NIP.md](NIP.md) · Canonical spec: [SIP-01 v1.1](https://github.com/NostrDanish/SIP-01/blob/main/public/spec/SIP-01.md)

### Relay Pool

Observations are published to:

**SIP-01-aware index relays:**
- `wss://relay-na1.metanomalist.com/`
- `wss://test-sip-relay.sip-01test.workers.dev/`
- `wss://sip-relay-2.sip-booster-relay.workers.dev/`
- `wss://sip-relay-3.uncaged-sip.workers.dev/`
- `wss://sip-relay-4.sip-relay-4.workers.dev/`

**Search relays (NIP-50):**
- `wss://relay.nostr.band/`
- `wss://relay.ditto.pub/`
- `wss://search.nos.today/` (read-only — "blocked: writes disabled")
- `wss://relay.noswhere.com/`

**Write relays (for propagation):**
- `wss://jskitty.cat/nostr`
- `wss://relay.primal.net/`
- `wss://relay.damus.io/`
- `wss://nostr.hifish.org/`
- `ws://acuy3mjnv26tkyaaucndlxmg2ocntz4rtebhavk57vgruozm42iaznqd.onion/` (Tor only — reachable from Tor Browser; clearnet browsers skip it)

Each observation is pushed to every relay in the set via targeted per-relay connections.

**Custom relays:** add your own in Settings → Publish relays. They persist locally and merge into the publish set. The built-in set can't be removed.

**Auto-discovery:** Settings → **Discover NIP-50 / SIP-01 relays** queries relay-monitor announcements (NIP-66 kind 30166), filters to relays advertising NIP-50, then verifies each candidate with a live capability probe (NIP-11 — checking `supported_nips` for 50 and the `uncaged_index` block for SIP-01). Verified candidates appear with one-click add; nothing is added automatically. Discovery is a hint, never a requirement — the built-in set keeps the app fully functional without it (NIP-66's risk guidance).

**Capability testing:** every relay in the list has a test button that probes its NIP-11 document and shows SIP-01 / NIP-50 badges plus latency.

---

## Federation: One Index, Many Crawlers

Crawlstr is **one more independent indexer** in the SIP-01 ecosystem:

```
Crawlstr (browser crawler)
    │
    ▼ kind 39697, signed by device indexer key
Nostr Relays
    │
    ├──→ 0xSearchstr (search engine) reads it
    ├──→ 0xPresearchstr (search engine) reads it
    ├──→ UNCAGED (search engine template) reads it
    └──→ Any SIP-01 client reads it
```

Multiple crawlers observing the same URL produce events with the **same `d` tag** and different pubkeys — search nodes group by `d` and count distinct authors ("7 independent indexers saw this page").

---

## Browser Limitations

Crawlstr is honest about what a browser can and cannot do:

- **CORS** — A browser cannot read cross-origin responses unless the site sends CORS headers, and most don't. Crawlstr tries a direct fetch first, then falls back to a **CORS proxy** so real websites can actually be crawled. The trade-off is honest: when the proxy is used, the proxy operator sees which URL was fetched (never a search query, never a user identity). The dashboard shows the direct/proxy split per session.
- **JavaScript rendering** — Crawlstr parses static HTML. Single-page apps that require JavaScript rendering won't have their full content extracted.
- **Background execution** — Mobile browsers may throttle or kill background tabs. The crawler is most effective when the tab is active.
- **Rate limits** — Per-domain rate limiting is built-in (5–8 seconds between requests). This is respectful by design.
- **Resource budgets are real** — the bandwidth cap counts **every** byte (pages, robots.txt, feeds, sitemaps, proxy overhead), and the pages/hour cap is enforced on a sliding window. The page-size cap is clamped to the remaining hourly budget so a single page can't overshoot it.
- **SSRF guard at the proxy boundary** — before any URL is handed to fetch (direct or proxied), it's checked against localhost, RFC1918, link-local (incl. cloud metadata `169.254.169.254`), CGNAT, and the odd IPv4 forms browsers accept (integer, hex, octal, short), plus IPv6 loopback/ULA/link-local. Direct-path redirects are re-checked against the same list. The remaining gap — a public URL that 302s into private space *at the proxy* — is the proxy operator's to close, and we say so.

For unrestricted crawling, run a desktop/CLI SIP-01 crawler alongside Crawlstr.

---

## Tech Stack

- **React 19** + TypeScript + Vite
- **TailwindCSS 4** + shadcn/ui
- **Nostrify** — Nostr relay pool
- **nostr-tools** — Event signing (`finalizeEvent`)
- **idb** — IndexedDB wrapper for the crawl queue
- **TanStack Query** — Data fetching + caching
- **PWA** — Service worker, manifest, installable

---

## Project Structure

```
src/
├── crawler/
│   ├── engine.ts           ← Main orchestrator: event-driven multi-slot loop,
│   │                         freshness gate, trap guards, negative cache,
│   │                         fire-and-track publish lane (source=crawlstr/v3)
│   ├── queue.ts            ← IndexedDB queue v4: atomic job claims, observed/
│   │                         fetched/failed split, adaptive recrawl fields,
│   │                         negative cache + maintenance sweep, outbox
│   ├── scheduler.ts        ← Politeness allocator: ≤1 request in flight per
│   │                         domain, interval pacing, parallel fetch slots
│   ├── fetcher.ts          ← HTTP fetcher: CORS direct→proxy, SSRF-guarded,
│   │                         stream-capped metered reads, permanent/transient
│   │                         failure classification
│   ├── freshness.ts        ← Adaptive recrawl scheduling (24h → 30d doubling)
│   ├── traps.ts            ← Crawl-trap guards (session state, generators,
│   │                         depth) + per-domain discovery cap
│   ├── backoff.ts          ← Bounded exponential backoff for transient failures
│   ├── safety.ts           ← SSRF guard — refuses non-public targets at the proxy boundary
│   ├── meter.ts            ← Sliding-window resource accounting (every byte, every page)
│   ├── parser.ts           ← HTML parser (title, description, text, links, language)
│   ├── hasher.ts           ← SHA-256 content hashing for local dedup + change detection
│   ├── webIndex.ts         ← SIP-01: URL normalization, event build/parse/verify
│   │                         (byte-compatible, spec §13 test vectors)
│   ├── indexerIdentity.ts  ← Per-device anonymous indexer keypair
│   ├── publisher.ts        ← Signs + publishes kind 39697, relay health gate,
│   │                         IndexedDB outbox on zero acks
│   ├── relays.ts           ← Ecosystem relay pool configuration
│   ├── robots.ts           ← robots.txt parser (policies + Sitemap: discovery)
│   ├── feed.ts             ← RSS/Atom detection + parsing (cheap discovery)
│   ├── sitemap.ts          ← XML sitemap parsing (urlset + sitemapindex, sampled)
│   ├── seeds.ts            ← Random Scout selection engine (weighted strategies)
│   ├── heartbeat.ts        ← Kind 16919 node heartbeat (schema: Indexstr)
│   ├── capabilities.ts     ← Coarse, privacy-minimal node capability profile
│   ├── relayDiscovery.ts   ← NIP-66 relay discovery (NIP-50 / SIP-01 aware)
│   ├── relayProbe.ts       ← NIP-11 capability probing through the SSRF guard
│   ├── sharding.ts         ← FNV-1a URL→shard map (heartbeat home shard)
│   └── types.ts            ← TypeScript interfaces (incl. crawl modes + stats)
├── data/
│   └── seeds/              ← The seed corpus: one plain-text file per category
├── components/
│   └── crawler/
│       └── CrawlerDashboard.tsx  ← Main UI (toggle, stats, seed, history, settings)
├── hooks/
│   └── useCrawler.ts       ← React hook wiring engine to Nostr
├── pages/
│   └── Index.tsx           ← Landing page + dashboard
└── NIP.md                  ← Protocol documentation
```

---

## Ecosystem

| Project | Role | URL |
|---------|------|-----|
| **Crawlstr** (this) | Lightweight scout → SIP-01 publisher | [crawlstr.shakespeare.wtf](https://crawlstr.shakespeare.wtf) |
| [Indexstr](https://github.com/NostrDanish/indxestr) | Heavyweight distributed indexer w/ collections | — |
| [0xSearchstr](https://github.com/NostrDanish/0xSearchstr) | Search engine → SIP-01 reader | [0xsearchstr.shakespeare.wtf](https://0xsearchstr.shakespeare.wtf) |
| [0xPresearchstr](https://github.com/NostrDanish/0xPresearchstr) | Community fork with keyword staking | [presearchstr.shakespeare.wtf](https://presearchstr.shakespeare.wtf) |
| [UNCAGED-ENGINE](https://github.com/NostrDanish/UNCAGED-ENGINE) | Minimal search engine template | [uncaged.shakespeare.wtf](https://uncaged.shakespeare.wtf) |

---

## Privacy, Honestly

- **No login required** to crawl. No account. No tracking.
- Crawl observations are signed by a **per-device anonymous keypair**, never your personal Nostr identity.
- Events contain **page metadata only** — never search queries, never browsing history.
- Your crawl history stays in your browser (IndexedDB). Clearing browser data removes it.
- Relay operators see the observation event and your IP address — that's how Nostr works. Key separation is guaranteed; network anonymity is not.
- Use a VPN or Tor — we recommend [NymVPN](https://nym.com).

**Support us:** [https://nym.com/pricing?ref=aYPKAFmGpJi](https://nym.com/pricing?ref=aYPKAFmGpJi)

---

## License

MIT

---

*Vibed with [Shakespeare](https://shakespeare.diy)*
