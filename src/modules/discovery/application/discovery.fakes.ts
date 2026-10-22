import { type Stage } from '../domain';
import { type LinkCheck, type LinkChecker } from './ports/link-checker';
import { type Paper, type PaperSearch } from './ports/paper-search';
import { type QuotaCounter } from './ports/quota-counter';
import { type Analysis, type AnalysisInput, type ResourceAnalyzer } from './ports/resource-analyzer';
import { type VideoDetails, VideoQuotaExceededError, type VideoSearch } from './ports/video-search';
import { type DiscoveryTopic, type WebDiscovery, type WebFind } from './ports/web-discovery';

// In-memory discovery adapters for application, integration and e2e tests: no network, scripted answers.

export class FakeVideoSearch implements VideoSearch {
  readonly searches: string[] = [];
  /** Query → ids; unknown queries return nothing. */
  readonly results = new Map<string, string[]>();
  readonly videos = new Map<string, VideoDetails>();
  quotaExceeded = false;

  search(input: { query: string }): Promise<string[]> {
    this.searches.push(input.query);
    if (this.quotaExceeded) return Promise.reject(new VideoQuotaExceededError('quotaExceeded'));
    return Promise.resolve(this.results.get(input.query) ?? []);
  }

  details(ids: string[]): Promise<VideoDetails[]> {
    return Promise.resolve(ids.map((id) => this.videos.get(id)).filter((v): v is VideoDetails => v !== undefined));
  }

  /** Adds a public, embeddable video and makes `query` return it. */
  add(query: string, video: Partial<VideoDetails> & { youtubeId: string }): VideoDetails {
    const details: VideoDetails = { title: `Video ${video.youtubeId}`, channel: 'Channel', durationMin: 12, publishedAt: '2026-01-10', language: 'en', embeddable: true, public: true, madeForKids: false, ...video };
    this.videos.set(details.youtubeId, details);
    this.results.set(query, [...(this.results.get(query) ?? []), details.youtubeId]);
    return details;
  }
}

export class FakeWebDiscovery implements WebDiscovery {
  readonly calls: { topic: DiscoveryTopic; stage: Stage; includeVideos: boolean }[] = [];
  /** Topic name → finds. */
  readonly finds = new Map<string, WebFind[]>();

  find(input: { topic: DiscoveryTopic; stage: Stage; includeVideos: boolean }): Promise<WebFind[]> {
    this.calls.push({ topic: input.topic, stage: input.stage, includeVideos: input.includeVideos });
    return Promise.resolve(this.finds.get(input.topic.name) ?? []);
  }
}

export class FakePaperSearch implements PaperSearch {
  readonly papers = new Map<string, Paper[]>();

  search(input: { query: string }): Promise<Paper[]> {
    return Promise.resolve(this.papers.get(input.query) ?? []);
  }
}

export class FakeLinkChecker implements LinkChecker {
  /** URL → status; anything not listed answers `fallback`. */
  readonly statuses = new Map<string, number>();
  readonly checked: string[] = [];
  readonly texts = new Map<string, string>();

  constructor(private readonly fallback: number | null = 200) {}

  check(url: string): Promise<LinkCheck> {
    this.checked.push(url);
    const status = this.statuses.has(url) ? (this.statuses.get(url) ?? null) : this.fallback;
    return Promise.resolve({ ok: status !== null && status >= 200 && status < 300, status });
  }

  fetchText(url: string): Promise<string | null> {
    return Promise.resolve(this.texts.get(url) ?? `Readable text of ${url}.`);
  }
}

export class FakeResourceAnalyzer implements ResourceAnalyzer {
  readonly promptVersion: string;
  readonly calls: AnalysisInput[] = [];
  /** URL → overrides for that resource's analysis. */
  readonly overrides = new Map<string, Partial<Analysis>>();
  fail: Error | null = null;

  constructor(promptVersion = 'v1') {
    this.promptVersion = promptVersion;
  }

  analyse(input: AnalysisInput): Promise<Analysis> {
    this.calls.push(input);
    if (this.fail) return Promise.reject(this.fail);
    return Promise.resolve({
      dreyfusStage: input.poolStage,
      bloomLevels: ['C2', 'C3'],
      prerequisites: [],
      concepts: input.kind === 'video' ? [{ name: 'Core idea', start: '00:30', end: '02:00' }] : [{ name: 'Core idea', start: null, end: null }],
      keyTakeaways: [`${input.title} explains ${input.topic.name}.`],
      whyThis: 'A clear introduction.',
      quality: { relevance: 85, accuracySignals: 80, recency: 75, teaching: 82 },
      confidence: 0.85,
      evidence: `From ${input.title}`,
      language: 'en',
      readingMin: input.kind === 'video' ? null : 8,
      model: input.kind === 'video' ? 'gemini-3.8-flash' : 'gemini-3.5-flash-lite',
      ...this.overrides.get(input.url),
    });
  }
}

export class FakeQuotaCounter implements QuotaCounter {
  readonly used_ = new Map<string, number>();

  tryTake(quota: string, day: string, limit: number): Promise<boolean> {
    const key = `${quota}:${day}`;
    const n = this.used_.get(key) ?? 0;
    if (n >= limit) return Promise.resolve(false);
    this.used_.set(key, n + 1);
    return Promise.resolve(true);
  }

  exhaust(quota: string, day: string, limit: number): Promise<void> {
    const key = `${quota}:${day}`;
    this.used_.set(key, Math.max(this.used_.get(key) ?? 0, limit));
    return Promise.resolve();
  }

  used(quota: string, day: string): Promise<number> {
    return Promise.resolve(this.used_.get(`${quota}:${day}`) ?? 0);
  }
}
