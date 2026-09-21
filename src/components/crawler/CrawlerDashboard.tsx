import { useState } from 'react';
import {
  Play,
  Square,
  Plus,
  Trash2,
  Globe,
  Clock,
  Database,
  Zap,
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Settings2,
  Wifi,
  BatteryCharging,
  Shield,
  Key,
  Copy,
  Check,
  Shuffle,
  Rss,
  Map,
  Link2,
  RotateCw,
  Send,
  Inbox,
  Ban,
  Gauge,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { CrawlstrLogo } from '@/components/crawler/CrawlstrLogo';
import { RelayManager } from '@/components/crawler/RelayManager';
import { useCrawler } from '@/hooks/useCrawler';
import { cn } from '@/lib/utils';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

/**
 * Seeds that are actually crawlable from a browser: open content, permissive
 * robots.txt, server-rendered HTML. Big platforms disallow crawling, so seeding
 * them produces an empty index and looks like a broken app.
 */
const SUGGESTED_SEEDS = [
  'https://en.wikipedia.org/wiki/Nostr',
  'https://bitcoin.org',
  'https://nostr.com',
  'https://news.ycombinator.com',
  'https://dev.to',
];

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${seconds % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function CrawlerDashboard() {
  const {
    isRunning,
    initialized,
    currentSeed,
    currentSeedCategory,
    stats,
    recentCrawls,
    indexerInfo,
    seedCount,
    scoutedCount,
    categories,
    start,
    stop,
    seedUrl,
    toggleScout,
    clearAll,
    updateSettings,
    getSettings,
  } = useCrawler();

  const [seedInput, setSeedInput] = useState('');
  const [copied, setCopied] = useState(false);
  // Settings live in the engine (not React state) — bump a tick to re-read
  // them after each change so switches reflect the new value immediately.
  // Without this, toggles appear unresponsive until the next stats tick.
  const [, setSettingsTick] = useState(0);
  const settings = getSettings();

  const changeSettings = (patch: Parameters<typeof updateSettings>[0]) => {
    updateSettings(patch);
    setSettingsTick((t) => t + 1);
  };

  const handleSeed = () => {
    if (!seedInput.trim()) return;
    let url = seedInput.trim();
    if (!url.startsWith('http')) {
      url = `https://${url}`;
    }
    seedUrl(url);
    setSeedInput('');
  };

  const copyNpub = () => {
    if (!indexerInfo) return;
    navigator.clipboard.writeText(indexerInfo.npub);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="w-full max-w-4xl mx-auto space-y-6">
      {/* Main Toggle Card */}
      <Card className={cn(
        'border-2 transition-colors duration-300',
        isRunning ? 'border-primary/50 bg-primary/5' : 'border-border'
      )}>
        <CardHeader className="pb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={cn(
                'p-2.5 rounded-xl transition-colors',
                isRunning ? 'bg-primary/15' : 'bg-muted'
              )}>
                <CrawlstrLogo
                  animated={isRunning}
                  className={cn(
                    'h-7 w-7 rounded-md',
                    !isRunning && 'opacity-60 grayscale',
                  )}
                />
              </div>
              <div>
                <CardTitle className="text-xl">
                  {isRunning ? 'Scout Active' : 'Scout Offline'}
                </CardTitle>
                <CardDescription>
                  {isRunning
                    ? currentSeed
                      ? `Scouting ${currentSeedCategory ? `${currentSeedCategory} — ` : ''}${new URL(currentSeed).hostname}`
                      : 'Scouting the open web'
                    : 'Scout the web. Feed the network.'}
                </CardDescription>
              </div>
            </div>
            <Button
              size="lg"
              variant={isRunning ? 'destructive' : 'default'}
              onClick={isRunning ? stop : () => start()}
              disabled={!initialized}
              className="gap-2 px-6"
            >
              {isRunning ? (
                <>
                  <Square className="h-4 w-4" />
                  Stop
                </>
              ) : (
                <>
                  <Play className="h-4 w-4" />
                  Start Crawling
                </>
              )}
            </Button>
          </div>
        </CardHeader>

        <CardContent className="pt-0 space-y-4">
          {/* Random Scout — ONE control: press to queue 5 fresh curated seeds
              and crawl until stopped; press again to stop; press once more
              for a fresh bundle. */}
          <div className="space-y-3">
            <Button
              size="lg"
              variant={isRunning ? 'destructive' : 'outline'}
              onClick={() => toggleScout()}
              disabled={!initialized}
              className={cn(
                'w-full gap-2',
                !isRunning && 'border-primary/40 hover:bg-primary/10 hover:text-primary',
              )}
            >
              {isRunning ? (
                <>
                  <Square className="h-4 w-4" />
                  Stop scouting
                </>
              ) : (
                <>
                  <Shuffle className="h-4 w-4" />
                  Scout random corners of the web
                </>
              )}
            </Button>
            <p className="text-xs text-center text-muted-foreground">
              Each press queues <span className="font-medium text-foreground">5 fresh starting points</span>{' '}
              from {seedCount.toLocaleString()} curated seeds across {categories.length} categories
              {scoutedCount > 0 && ` · you've scouted ${scoutedCount}`} — then keeps finding new
              corners until you stop it.
            </p>
          </div>
        </CardContent>

        {/* Live status indicator */}
        {isRunning && (
          <CardContent className="pt-0 space-y-2">
            <div className="flex items-center gap-2 text-sm text-primary">
              <span className="relative flex h-2.5 w-2.5">
                <span className="motion-safe:animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-primary" />
              </span>
              Crawling... Uptime: {formatUptime(stats.uptime)}
            </div>
            {stats.queueSize === 0 && (
              <div className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
                The queue is empty — the scout has nothing to crawl yet. Add a
                seed URL in the <span className="font-medium text-foreground">Seed URLs</span> tab,
                or stop and press <span className="font-medium text-foreground">Explore a random corner of the web</span>.
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Your node publishes a heartbeat (kind 16919) every 10 min — visible on the SIP-01 network dashboard.
            </p>
          </CardContent>
        )}
      </Card>

      {/* Why pages were skipped — otherwise "0 indexed" looks like a broken app */}
      {(stats.skipped > 0 || stats.fetchFailed > 0) && (
        <Card className="border-chart-4/40 bg-chart-4/5">
          <CardContent className="pt-6 space-y-3">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-chart-4 shrink-0" />
              <p className="text-sm font-medium">
                Why pages weren't indexed
              </p>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <div>
                <div className="font-bold">{stats.robotsBlocked.toLocaleString()}</div>
                <div className="text-xs text-muted-foreground">robots.txt disallowed</div>
              </div>
              <div>
                <div className="font-bold">{stats.fetchFailed.toLocaleString()}</div>
                <div className="text-xs text-muted-foreground">unreachable</div>
              </div>
              <div>
                <div className="font-bold">{stats.thinContent.toLocaleString()}</div>
                <div className="text-xs text-muted-foreground">too little text</div>
              </div>
              <div>
                <div className="font-bold">{stats.duplicates.toLocaleString()}</div>
                <div className="text-xs text-muted-foreground">duplicate content</div>
              </div>
              {(stats.trapsBlocked > 0 || stats.ssrfBlocked > 0) && (
                <>
                  <div>
                    <div className="font-bold">{stats.trapsBlocked.toLocaleString()}</div>
                    <div className="text-xs text-muted-foreground">crawl traps refused</div>
                  </div>
                  <div>
                    <div className="font-bold">{stats.ssrfBlocked.toLocaleString()}</div>
                    <div className="text-xs text-muted-foreground">non-public targets refused</div>
                  </div>
                </>
              )}
            </div>

            {stats.trapsBlocked > 0 && (
              <p className="text-xs text-muted-foreground">
                Trap URLs (session state, calendar generators, infinite paginators)
                are refused at the queue gate — one hostile page can't eat the
                whole crawl budget.
              </p>
            )}

            {stats.robotsBlocked > 0 && stats.pagesIndexed === 0 && (
              <p className="text-xs text-muted-foreground">
                Most large platforms (Google, YouTube, Facebook, X) disallow
                crawling in their robots.txt, so they're skipped by design. Try a
                crawler-friendly seed from the Seed URLs tab.
              </p>
            )}

            {stats.thinContent > 0 && (
              <p className="text-xs text-muted-foreground">
                Pages with little text are usually JavaScript-rendered apps —
                Crawlstr parses static HTML only.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Indexer Identity Card */}
      {indexerInfo && (
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3 min-w-0">
                <div className="p-2 rounded-lg bg-primary/10 text-primary shrink-0">
                  <Key className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium">Indexer Identity (SIP-01)</p>
                  <p className="text-xs text-muted-foreground font-mono truncate">
                    {indexerInfo.npub}
                  </p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={copyNpub}
                className="shrink-0"
              >
                {copied ? <Check className="h-4 w-4 text-primary" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Per-device pseudonymous keypair. Signs kind 39697 observations.
              Separate from your personal Nostr identity.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Database className="h-4 w-4" />
              <span className="text-xs font-medium">Indexed</span>
            </div>
            <div className="text-2xl font-bold">{stats.pagesIndexed.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">pages</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Clock className="h-4 w-4" />
              <span className="text-xs font-medium">Queue</span>
            </div>
            <div className="text-2xl font-bold">{stats.queueSize.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">pending</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Zap className="h-4 w-4" />
              <span className="text-xs font-medium">Bandwidth</span>
            </div>
            <div className="text-2xl font-bold">{formatBytes(stats.bandwidthUsed)}</div>
            <p className="text-xs text-muted-foreground">used</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Globe className="h-4 w-4" />
              <span className="text-xs font-medium">Protocol</span>
            </div>
            <div className="text-2xl font-bold">SIP-01</div>
            <p className="text-xs text-muted-foreground">kind 39697</p>
          </CardContent>
        </Card>
      </div>

      {/* Network strip — what actually reached the shared index (v2) */}
      <Card>
        <CardContent className="py-4">
          <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-2 text-sm">
            <div className="flex items-center gap-2">
              <Send className="h-4 w-4 text-primary" />
              <span className="font-bold">{stats.published.toLocaleString()}</span>
              <span className="text-muted-foreground text-xs">published (relay-acked)</span>
            </div>
            <div className="flex items-center gap-2">
              <Inbox className="h-4 w-4 text-primary" />
              <span className="font-bold">{stats.outboxPending.toLocaleString()}</span>
              <span className="text-muted-foreground text-xs">held in outbox</span>
            </div>
            <div className="flex items-center gap-2">
              <RotateCw className="h-4 w-4 text-primary" />
              <span className="font-bold">{stats.recrawls.toLocaleString()}</span>
              <span className="text-muted-foreground text-xs">adaptive recrawls</span>
            </div>
            <div className="flex items-center gap-2">
              <Ban className="h-4 w-4 text-primary" />
              <span className="font-bold">{(stats.trapsBlocked + stats.ssrfBlocked).toLocaleString()}</span>
              <span className="text-muted-foreground text-xs">traps & non-public refused</span>
            </div>
          </div>
          <p className="text-xs text-center text-muted-foreground mt-3">
            Every page is revisited on a change-detected schedule (24h → 30d) and
            republished — the network's freshness signal. Nothing runs without
            pressing Start.
          </p>
        </CardContent>
      </Card>

      {/* Discovery strip — the scout's contribution beyond pages */}
      {(stats.urlsDiscovered > 0 || stats.feedsFound > 0 || stats.sitemapsFound > 0) && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="py-4">
            <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-2 text-sm">
              <div className="flex items-center gap-2">
                <Link2 className="h-4 w-4 text-primary" />
                <span className="font-bold">{stats.urlsDiscovered.toLocaleString()}</span>
                <span className="text-muted-foreground text-xs">URLs discovered</span>
              </div>
              <div className="flex items-center gap-2">
                <Rss className="h-4 w-4 text-primary" />
                <span className="font-bold">{stats.feedsFound.toLocaleString()}</span>
                <span className="text-muted-foreground text-xs">feeds found</span>
              </div>
              <div className="flex items-center gap-2">
                <Map className="h-4 w-4 text-primary" />
                <span className="font-bold">{stats.sitemapsFound.toLocaleString()}</span>
                <span className="text-muted-foreground text-xs">sitemaps found</span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Tabs for Seed / History / Settings */}
      <Tabs defaultValue="seed" className="w-full">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="seed">Seed URLs</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
          <TabsTrigger value="settings">
            <Settings2 className="h-4 w-4 mr-1" />
            Settings
          </TabsTrigger>
        </TabsList>

        {/* Seed URL Tab */}
        <TabsContent value="seed">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Add URLs to Crawl</CardTitle>
              <CardDescription>
                Enter a URL to start crawling. Pages are published as SIP-01 observations
                (kind 39697) readable by 0xSearchstr, 0xPresearchstr, UNCAGED, and any compatible client.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Input
                  placeholder="https://example.com"
                  value={seedInput}
                  onChange={(e) => setSeedInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSeed()}
                  className="flex-1"
                />
                <Button onClick={handleSeed} disabled={!seedInput.trim()}>
                  <Plus className="h-4 w-4 mr-1" />
                  Add
                </Button>
              </div>

              {/* Crawler-friendly starting points */}
              <div className="rounded-lg border border-dashed p-3 space-y-2">
                <p className="text-xs font-medium text-muted-foreground">
                  Crawler-friendly seeds (open content, permissive robots.txt)
                </p>
                <div className="flex flex-wrap gap-2">
                  {SUGGESTED_SEEDS.map((url) => (
                    <Button
                      key={url}
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs font-mono"
                      onClick={() => seedUrl(url)}
                    >
                      <Plus className="h-3 w-3 mr-1" />
                      {url.replace('https://', '')}
                    </Button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Large platforms (Google, YouTube, Facebook, X) disallow crawling
                  in robots.txt and are skipped by design.
                </p>
              </div>

              <Separator />

              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  {stats.queueSize} URL{stats.queueSize !== 1 ? 's' : ''} in queue
                </p>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" size="sm" className="text-destructive">
                      <Trash2 className="h-4 w-4 mr-1" />
                      Clear Queue
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Clear crawl queue?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This will remove all {stats.queueSize} pending URLs from the queue.
                        Already crawled pages will remain in the index.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={clearAll}>Clear Queue</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* History Tab */}
        <TabsContent value="history">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Recently Crawled</CardTitle>
              <CardDescription>
                Pages indexed by this browser, published as SIP-01 observations
              </CardDescription>
            </CardHeader>
            <CardContent>
              {recentCrawls.length === 0 ? (
                <div className="py-12 text-center text-muted-foreground">
                  <Globe className="h-12 w-12 mx-auto mb-4 opacity-20" />
                  <p>No pages crawled yet.</p>
                  <p className="text-sm mt-1">Add a seed URL and start the crawler.</p>
                </div>
              ) : (
                <ScrollArea className="h-[400px]">
                  <div className="space-y-3">
                    {recentCrawls.map((page) => (
                      <div
                        key={page.url}
                        className="flex items-start gap-3 p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors"
                      >
                        <CheckCircle2 className="h-4 w-4 text-primary mt-1 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <p className="font-medium text-sm truncate">
                            {page.title || 'Untitled'}
                          </p>
                          <a
                            href={page.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 mt-0.5"
                          >
                            <span className="truncate">{page.url}</span>
                            <ExternalLink className="h-3 w-3 shrink-0" />
                          </a>
                          <div className="flex items-center gap-2 mt-1">
                            <p className="text-xs text-muted-foreground">
                              {new Date(page.crawledAt).toLocaleString()}
                            </p>
                            <Badge variant="outline" className="text-xs">
                              kind 39697
                            </Badge>
                            {page.status === 'observed' && (
                              <Badge variant="secondary" className="text-xs">
                                observed via feed
                              </Badge>
                            )}
                            {page.status === 'failed' && (
                              <Badge variant="destructive" className="text-xs">
                                failed
                              </Badge>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Settings Tab */}
        <TabsContent value="settings">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Crawler Settings</CardTitle>
              <CardDescription>
                Control how the crawler behaves. Nothing runs unless you explicitly enable it.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Wifi className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <Label htmlFor="wifi-only">WiFi Only</Label>
                      <p className="text-xs text-muted-foreground">Only crawl on WiFi networks</p>
                    </div>
                  </div>
                  <Switch
                    id="wifi-only"
                    checked={settings.wifiOnly}
                    onCheckedChange={(v) => changeSettings({ wifiOnly: v })}
                  />
                </div>

                <Separator />

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <BatteryCharging className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <Label htmlFor="charging-only">Charging Only</Label>
                      <p className="text-xs text-muted-foreground">Only crawl while device is charging</p>
                    </div>
                  </div>
                  <Switch
                    id="charging-only"
                    checked={settings.chargingOnly}
                    onCheckedChange={(v) => changeSettings({ chargingOnly: v })}
                  />
                </div>

                <Separator />

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Shield className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <Label htmlFor="respect-robots">Respect robots.txt</Label>
                      <p className="text-xs text-muted-foreground">Follow website crawling policies</p>
                    </div>
                  </div>
                  <Switch
                    id="respect-robots"
                    checked={settings.respectRobots}
                    onCheckedChange={(v) => changeSettings({ respectRobots: v })}
                  />
                </div>

                <Separator />

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Zap className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <Label htmlFor="eco-mode">Eco Mode</Label>
                      <p className="text-xs text-muted-foreground">Slower crawling, less resource usage</p>
                    </div>
                  </div>
                  <Switch
                    id="eco-mode"
                    checked={settings.ecoMode}
                    onCheckedChange={(v) => changeSettings({ ecoMode: v })}
                  />
                </div>

                <Separator />

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Gauge className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <Label htmlFor="bandwidth-cap">Bandwidth Cap</Label>
                      <p className="text-xs text-muted-foreground">
                        Limit data usage (25 MB/hour) — turn off and it just runs
                      </p>
                    </div>
                  </div>
                  <Switch
                    id="bandwidth-cap"
                    checked={settings.maxBandwidthMB > 0}
                    onCheckedChange={(v) => changeSettings({ maxBandwidthMB: v ? 25 : 0 })}
                  />
                </div>

                <Separator />

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Rss className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <Label htmlFor="follow-feeds">Follow RSS/Atom feeds</Label>
                      <p className="text-xs text-muted-foreground">Index feed entries — cheap, high-quality discovery</p>
                    </div>
                  </div>
                  <Switch
                    id="follow-feeds"
                    checked={settings.followFeeds}
                    onCheckedChange={(v) => changeSettings({ followFeeds: v })}
                  />
                </div>

                <Separator />

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Map className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <Label htmlFor="follow-sitemaps">Read sitemaps</Label>
                      <p className="text-xs text-muted-foreground">Use sitemap.xml for discovery (sampled, bounded)</p>
                    </div>
                  </div>
                  <Switch
                    id="follow-sitemaps"
                    checked={settings.followSitemaps}
                    onCheckedChange={(v) => changeSettings({ followSitemaps: v })}
                  />
                </div>

                <Separator />

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <RotateCw className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <Label htmlFor="adaptive-recrawl">Adaptive recrawls</Label>
                      <p className="text-xs text-muted-foreground">
                        Revisit crawled pages on a change-detected schedule (24h → 30d) and republish the freshness signal
                      </p>
                    </div>
                  </div>
                  <Switch
                    id="adaptive-recrawl"
                    checked={settings.recrawlEnabled}
                    onCheckedChange={(v) => changeSettings({ recrawlEnabled: v })}
                  />
                </div>
              </div>

              <Separator />

              {/* Relay management */}
              <RelayManager />

              <Separator />

              <div className="rounded-lg bg-muted/50 p-4 space-y-2">
                <h4 className="font-medium text-sm flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-chart-4" />
                  Privacy & Trust
                </h4>
                <ul className="text-sm text-muted-foreground space-y-1">
                  <li className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="text-xs">No tracking</Badge>
                    <Badge variant="outline" className="text-xs">No analytics</Badge>
                    <Badge variant="outline" className="text-xs">SIP-01</Badge>
                    <Badge variant="outline" className="text-xs">kind 39697</Badge>
                  </li>
                  <li>The crawler only runs when you explicitly enable it.</li>
                  <li>
                    Observations are signed by a per-device indexer key
                    ({indexerInfo ? indexerInfo.npub.slice(0, 16) + '...' : 'generating...'}),
                    never your personal Nostr identity.
                  </li>
                  <li>Events contain page metadata only — never search queries.</li>
                  <li>Your crawl history stays in your browser (IndexedDB).</li>
                  <li>
                    <span className="text-chart-4 font-medium">
                      Most sites block direct browser access (CORS).
                    </span>{' '}
                    Those requests are routed through a CORS proxy, so the proxy
                    operator can see which URLs are fetched. Pages fetched this
                    session: {stats.viaDirect} direct, {stats.viaProxy} via proxy.
                  </li>
                  <li>
                    Compatible with{' '}
                    <a href="https://github.com/NostrDanish/0xSearchstr" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">0xSearchstr</a>,{' '}
                    <a href="https://github.com/NostrDanish/0xPresearchstr" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">0xPresearchstr</a>, and{' '}
                    <a href="https://github.com/NostrDanish/UNCAGED-ENGINE" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">UNCAGED</a>.
                  </li>
                </ul>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
