import { Inject, Injectable } from '@nestjs/common';
import { EventBus } from '../../../shared/events';
import { type EnqueueRequest, type JobContext, type JobHandler, type JobOutcome, JobQueue } from '../../../shared/jobs';
import { LIVENESS_INTERVAL_MS, nextLiveness, ResourceDead, YOUTUBE_METADATA_REFRESH_DAYS } from '../domain';
import { CHECK_LIVENESS_JOB, checkLivenessPayload, DAY_MS, LIVENESS_SWEEP_JOB, livenessSweepPayload } from './jobs';
import { type Clock, DISCOVERY_CLOCK, DISCOVERY_REPOSITORY, type DiscoveryRepository, type ResourceRecord } from './ports/discovery.repository';
import { type LinkCheck, LINK_CHECKER, type LinkChecker } from './ports/link-checker';
import { VIDEO_SEARCH, type VideoSearch } from './ports/video-search';

/** Resources checked per daily sweep; the rest wait for the next day (oldest first). */
const SWEEP_LIMIT = 2_000;
/** The sweep runs at 03:00 UTC. */
const SWEEP_HOUR_UTC = 3;

const utcDay = (date: Date): string => date.toISOString().slice(0, 10);

/** Today's sweep job (idempotent per UTC day); the module enqueues it at boot and each sweep enqueues the next. */
export function sweepRequest(day: string, runAfter?: Date): EnqueueRequest {
  return { type: LIVENESS_SWEEP_JOB, idempotencyKey: `sweep:${day}`, payload: { day }, userId: null, maxAttempts: 2, ...(runAfter ? { runAfter } : {}) };
}

/** Daily: enqueues one `check-liveness` job per live resource not checked for 24 hours (FR-12). */
@Injectable()
export class LivenessSweep implements JobHandler<{ day: string }> {
  readonly type = LIVENESS_SWEEP_JOB;
  readonly concurrency = 1;
  readonly timeoutMs = 60_000;

  constructor(
    @Inject(DISCOVERY_REPOSITORY) private readonly repo: DiscoveryRepository,
    @Inject(DISCOVERY_CLOCK) private readonly clock: Clock,
    private readonly queue: JobQueue,
  ) {}

  parse(payload: unknown): { day: string } {
    return livenessSweepPayload.parse(payload);
  }

  async run({ day }: { day: string }): Promise<JobOutcome> {
    const now = this.clock();
    const due = await this.repo.dueForLiveness(new Date(now.getTime() - LIVENESS_INTERVAL_MS), SWEEP_LIMIT);
    for (const resourceId of due) {
      await this.queue.enqueue({ type: CHECK_LIVENESS_JOB, idempotencyKey: `${resourceId}:${day}`, payload: { resourceId }, userId: null, maxAttempts: 2 });
    }
    const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, SWEEP_HOUR_UTC));
    await this.queue.enqueue(sweepRequest(utcDay(tomorrow), tomorrow));
    return { resultRef: `/discovery/liveness/${day}`, result: { queued: due.length } };
  }
}

/**
 * `check-liveness` (PRD-API §5: concurrency 4, 10 s per URL, 1 retry): links must answer 2xx; videos must
 * still be public and embeddable per `videos.list`, whose metadata is refreshed within 30 days. Two
 * failures in a row mark the resource dead and publish ResourceDead.
 */
@Injectable()
export class CheckLiveness implements JobHandler<{ resourceId: string }> {
  readonly type = CHECK_LIVENESS_JOB;
  readonly concurrency = 4;
  readonly timeoutMs = 15_000;

  constructor(
    @Inject(DISCOVERY_REPOSITORY) private readonly repo: DiscoveryRepository,
    @Inject(LINK_CHECKER) private readonly links: LinkChecker,
    @Inject(VIDEO_SEARCH) private readonly videos: VideoSearch,
    @Inject(DISCOVERY_CLOCK) private readonly clock: Clock,
    private readonly events: EventBus,
  ) {}

  parse(payload: unknown): { resourceId: string } {
    return checkLivenessPayload.parse(payload);
  }

  async run({ resourceId }: { resourceId: string }, ctx: JobContext): Promise<JobOutcome> {
    const resultRef = `/discovery/resources/${resourceId}`;
    const resource = await this.repo.getResource(resourceId);
    if (!resource || resource.deadAt) return { resultRef, result: { outcome: 'skipped' } };

    const check = resource.youtubeId ? await this.checkVideo(resource, ctx.signal) : await this.links.check(resource.url, ctx.signal);
    const update = nextLiveness(resource.failedChecks, check.ok);
    const becameDead = await this.repo.saveLiveness(resourceId, { httpStatus: check.status, ...update, at: this.clock() });
    if (becameDead) await this.events.publish(new ResourceDead(resourceId, resource.url));
    return { resultRef, result: { ok: check.ok, status: check.status, dead: update.dead } };
  }

  private async checkVideo(resource: ResourceRecord, signal: AbortSignal): Promise<LinkCheck> {
    const [video] = await this.videos.details([resource.youtubeId as string], signal);
    if (!video || !video.public || !video.embeddable) return { ok: false, status: video ? 403 : 404 };
    const fetchedAt = resource.metadataFetchedAt?.getTime() ?? 0;
    if (this.clock().getTime() - fetchedAt > YOUTUBE_METADATA_REFRESH_DAYS * DAY_MS) {
      await this.repo.refreshVideo(resource.id, { title: video.title, source: video.channel, durationMin: video.durationMin, publishedAt: video.publishedAt, at: this.clock() });
    }
    return { ok: true, status: 200 };
  }
}
