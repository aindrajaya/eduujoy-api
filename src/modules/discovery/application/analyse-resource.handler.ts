import { Inject, Injectable, Logger } from '@nestjs/common';
import { AiCallError, EMBEDDER, type Embedder } from '../../../shared/ai';
import { ReviewQueue } from '../../../shared/common/review';
import { type Tx } from '../../../shared/db';
import { type TxScope, UnitOfWork } from '../../../shared/events';
import { type JobContext, type JobHandler, type JobOutcome } from '../../../shared/jobs';
import { GetTopicProfileQuery } from '../../catalog/application/get-topic-profile.query';
import {
  ANALYSIS_TOKEN_CAP,
  CARD_TTL_DAYS,
  type CardStatus,
  DUPLICATE_SIMILARITY,
  embeddingText,
  judgeCard,
  MAX_TEXT_CHARS,
  POOL_TTL_DAYS,
  poolStatus,
  qualityScore,
  ResourcesReady,
  videoPlan,
} from '../domain';
import { ANALYSE_RESOURCE_JOB, type AnalysePayload, analysePayload, DAY_MS } from './jobs';
import {
  type Clock,
  DISCOVERY_CLOCK,
  DISCOVERY_REPOSITORY,
  type DiscoveryRepository,
  type NewCard,
  type PoolRecord,
  type ResourceRecord,
  type ReusableAnalysis,
} from './ports/discovery.repository';
import { LINK_CHECKER, type LinkChecker } from './ports/link-checker';
import { type AnalysisInput, RESOURCE_ANALYZER, type ResourceAnalyzer } from './ports/resource-analyzer';


type Outcome = 'cached' | 'reused' | 'analysed' | 'skipped';

interface Analysed {
  card: NewCard;
  /** Absent when the analysis was reused: the resource row already has them. */
  readingMin?: number | null;
  language?: string;
  reused: boolean;
}

/**
 * `analyse-resource` (PRD-API §5, FR-09 to FR-11): one ResourceCard per resource, topic and prompt
 * version, reused while unexpired. Low-confidence cards go to the review queue, cards under 60 are
 * dropped, near-duplicates keep the better one. The job that analyses a pool's last resource settles
 * the pool and publishes ResourcesReady. A resource that cannot be analysed still counts as done, so a
 * pool never waits forever.
 */
@Injectable()
export class AnalyseResource implements JobHandler<AnalysePayload> {
  readonly type = ANALYSE_RESOURCE_JOB;
  readonly concurrency = 2;
  readonly timeoutMs = 180_000;
  private readonly logger = new Logger(AnalyseResource.name);

  constructor(
    @Inject(DISCOVERY_REPOSITORY) private readonly repo: DiscoveryRepository,
    @Inject(RESOURCE_ANALYZER) private readonly analyzer: ResourceAnalyzer,
    @Inject(LINK_CHECKER) private readonly links: LinkChecker,
    @Inject(EMBEDDER) private readonly embedder: Embedder,
    @Inject(DISCOVERY_CLOCK) private readonly clock: Clock,
    private readonly topics: GetTopicProfileQuery,
    private readonly reviews: ReviewQueue,
    private readonly uow: UnitOfWork,
  ) {}

  parse(payload: unknown): AnalysePayload {
    return analysePayload.parse(payload);
  }

  async run(payload: AnalysePayload, ctx: JobContext): Promise<JobOutcome> {
    const resultRef = `/discovery/pools/${payload.poolId}/resources/${payload.resourceId}`;
    const promptVersion = this.analyzer.promptVersion;
    const resource = await this.repo.getResource(payload.resourceId);

    let outcome: Outcome = 'skipped';
    let analysed: Analysed | null = null;
    if (resource && !resource.deadAt) {
      if (await this.repo.findCard(resource.id, payload.topicId, promptVersion, this.clock())) {
        outcome = 'cached';
      } else {
        try {
          analysed = await this.analyse(resource, payload, promptVersion, ctx);
          outcome = analysed ? (analysed.reused ? 'reused' : 'analysed') : 'skipped';
        } catch (error) {
          // Retry transient failures while attempts remain; after that, the pool moves on without it.
          const retryable = !(error instanceof AiCallError) || error.retryable;
          if (retryable && ctx.attempt < ctx.maxAttempts) throw error;
          this.logger.warn({ err: error instanceof Error ? error : new Error(String(error)), resourceId: payload.resourceId }, 'Resource analysis failed');
        }
      }
    }

    const settled = await this.uow.run(async (tx, scope) => {
      if (analysed && resource) await this.saveCard(tx, analysed, resource);
      return this.markDone(tx, scope, payload, promptVersion);
    });
    await ctx.progress('analyse', 1, 1);
    return { resultRef, result: { outcome, status: analysed?.card.status ?? null, poolSettled: settled } };
  }

  private async analyse(resource: ResourceRecord, payload: AnalysePayload, promptVersion: string, ctx: JobContext): Promise<Analysed | null> {
    const profile = await this.topics.execute(payload.topicId);
    if (!profile) return null;
    const isVideo = resource.type === 'youtube';
    const now = this.clock();

    // Decision 3 (user, 22 Oct 2026): the same URL and prompt version analysed for another topic in the
    // last 30 days is reused, so a second topic spends nothing on analysis or embedding.
    const reused = await this.repo.findRecentAnalysis(resource.id, promptVersion, new Date(now.getTime() - CARD_TTL_DAYS * DAY_MS));
    if (reused) return { card: await this.judge(resource, payload, promptVersion, reused, reused.embedding, ctx), reused: true };

    // The per-resource cap (user requirement, 23 Oct 2026): decided before the Gemini call, from the
    // video's length or the text's size, so one resource can never exceed ANALYSIS_TOKEN_CAP.
    let clip: AnalysisInput['clip'];
    if (isVideo) {
      const plan = videoPlan(resource.durationMin);
      if (plan.action === 'skip') {
        this.logger.log({ url: resource.url, topicId: payload.topicId, durationMin: resource.durationMin, reason: plan.reason }, 'Resource analysis skipped: over the analysis cap');
        return null;
      }
      clip = { fps: plan.fps, endSec: plan.endSec };
      if (plan.fps < 1 || plan.clipped) {
        this.logger.log(
          { url: resource.url, topicId: payload.topicId, durationMin: resource.durationMin, fps: plan.fps, endSec: plan.endSec, estimatedTokens: plan.estimatedTokens },
          plan.clipped ? 'Resource analysis clipped to fit the analysis cap' : 'Resource analysis at a lower frame rate to fit the analysis cap',
        );
      }
    }
    const raw = isVideo ? null : (payload.abstract ?? (await this.links.fetchText(resource.url, MAX_TEXT_CHARS, ctx.signal)));
    if (!isVideo && !raw) return null;
    const content = raw === null ? null : raw.slice(0, MAX_TEXT_CHARS);

    const analysis = await this.analyzer.analyse({
      kind: isVideo ? 'video' : 'text',
      topic: { id: profile.id, name: profile.canonicalName, description: profile.description, domain: profile.domain },
      poolStage: payload.stage,
      url: resource.url,
      title: resource.title,
      source: resource.source,
      durationMin: resource.durationMin,
      content,
      ...(clip ? { clip } : {}),
      budgetScope: payload.budgetScope,
      jobId: ctx.jobId,
      signal: ctx.signal,
    });
    if (analysis.inputTokens > ANALYSIS_TOKEN_CAP) {
      // The estimate was too low; the call is already billed, so make it visible for recalibration.
      this.logger.warn({ url: resource.url, inputTokens: analysis.inputTokens, cap: ANALYSIS_TOKEN_CAP }, 'Resource analysis exceeded the analysis cap');
    }
    const embedding = judgeCard({ quality: analysis.quality, confidence: analysis.confidence, concepts: analysis.concepts, durationMin: resource.durationMin, isVideo }).status === 'dropped'
      ? null
      : await this.embed(resource, analysis, ctx, payload.budgetScope);
    const card = await this.judge(resource, payload, promptVersion, analysis, embedding, ctx);
    return { card, readingMin: isVideo ? null : analysis.readingMin, language: analysis.language, reused: false };
  }

  private async embed(resource: ResourceRecord, analysis: Pick<NewCard, 'keyTakeaways' | 'concepts'>, ctx: JobContext, budgetScope: AnalysePayload['budgetScope']): Promise<NewCard['embedding']> {
    const embedded = await this.embedder.embed({
      stage: 'analyse',
      kind: 'document',
      texts: [embeddingText({ title: resource.title, keyTakeaways: analysis.keyTakeaways, concepts: analysis.concepts })],
      titles: [resource.title],
      jobId: ctx.jobId,
      budgetScope,
    });
    const vector = embedded.vectors[0];
    return vector ? { vector, model: embedded.model, version: embedded.version } : null;
  }

  /** Applies the card rules and the in-topic dedupe to an analysis, new or reused. */
  private async judge(
    resource: ResourceRecord,
    payload: AnalysePayload,
    promptVersion: string,
    analysis: Omit<ReusableAnalysis, 'embedding'>,
    embedding: NewCard['embedding'],
    ctx: JobContext,
  ): Promise<NewCard> {
    const isVideo = resource.type === 'youtube';
    const verdict = judgeCard({ quality: analysis.quality, confidence: analysis.confidence, concepts: analysis.concepts, durationMin: resource.durationMin, isVideo });
    const score = qualityScore(analysis.quality);
    let status: CardStatus = verdict.status;
    let reason = verdict.reason;
    if (status === 'dropped') {
      // Logged with its scores so the 60 cut-off can be tuned (user decision 2, 22 Oct 2026).
      this.logger.log({ url: resource.url, topicId: payload.topicId, jobId: ctx.jobId, qualityScore: score, quality: analysis.quality }, 'Resource card dropped under the quality floor');
    }
    if (status === 'served' && embedding) {
      const nearest = await this.repo.nearestServedCard(payload.topicId, embedding.vector, resource.id);
      if (nearest && nearest.similarity >= DUPLICATE_SIMILARITY && nearest.card.qualityScore >= score) {
        status = 'duplicate';
        reason = `duplicate of card ${nearest.card.id}`;
      }
    }
    return {
      resourceId: resource.id,
      topicId: payload.topicId,
      model: analysis.model,
      promptVersion,
      dreyfusStage: analysis.dreyfusStage,
      bloomLevels: analysis.bloomLevels,
      prerequisites: analysis.prerequisites,
      concepts: analysis.concepts,
      keyTakeaways: analysis.keyTakeaways,
      whyThis: analysis.whyThis,
      quality: analysis.quality,
      qualityScore: score,
      confidence: analysis.confidence,
      evidence: analysis.evidence,
      status,
      reviewReason: reason,
      embedding,
      expiresAt: new Date(this.clock().getTime() + CARD_TTL_DAYS * DAY_MS),
    };
  }

  private async saveCard(tx: Tx, { card, readingMin, language }: Analysed, resource: ResourceRecord): Promise<void> {
    const cardId = await this.repo.saveCard(tx, card);
    if (card.status === 'served' && card.embedding) {
      // The better of two near-duplicates stays served (PRD-API §9).
      const nearest = await this.repo.nearestServedCard(card.topicId, card.embedding.vector, card.resourceId);
      if (nearest && nearest.similarity >= DUPLICATE_SIMILARITY && nearest.card.qualityScore < card.qualityScore) {
        await this.repo.setCardStatus(tx, nearest.card.id, 'duplicate', `duplicate of card ${cardId}`);
      }
    }
    if (card.status === 'review') {
      await this.reviews.flag(tx, {
        kind: 'resource',
        targetId: cardId,
        reason: card.reviewReason ?? 'needs review',
        detail: { url: resource.url, topicId: card.topicId, confidence: card.confidence, evidence: card.evidence },
      });
    }
    if (language !== undefined) await this.repo.recordAnalysis(tx, resource.id, { readingMin: readingMin ?? null, language });
  }

  /** Counts the resource as analysed; the last one settles the pool. Returns whether this job settled it. */
  private async markDone(tx: Tx, scope: TxScope, payload: AnalysePayload, promptVersion: string): Promise<boolean> {
    const pool = await this.repo.markAnalysed(tx, payload.poolId, payload.resourceId);
    if (!pool || pool.status !== 'analysing' || pool.analysedIds.length < pool.candidateIds.length) return false;
    await this.settle(tx, scope, pool, promptVersion);
    return true;
  }

  private async settle(tx: Tx, scope: TxScope, pool: PoolRecord, promptVersion: string): Promise<void> {
    const served = (await this.repo.poolCards(tx, pool, promptVersion))
      .filter((c) => c.status === 'served')
      .sort((a, b) => b.qualityScore - a.qualityScore);
    const status = poolStatus(served.map((c) => c.type));
    const now = this.clock().getTime();
    // A thin pool is retried after a day; a ready one is shared for 30 days (PRD-API §10).
    const expiresAt = new Date(now + (status === 'ready' ? POOL_TTL_DAYS : 1) * DAY_MS);
    const resourceIds = served.map((c) => c.resourceId);
    await this.repo.settlePool(tx, pool.id, status, resourceIds, expiresAt);
    scope.publish(new ResourcesReady(pool.id, pool.topicId, pool.stage, pool.poolVersion, status, resourceIds));
  }
}
