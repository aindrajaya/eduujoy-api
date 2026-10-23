import { Inject, Injectable } from '@nestjs/common';
import { ProblemException } from '../../../shared/common/problem/problem';
import { EventBus } from '../../../shared/events';
import { GetTopicQuery } from '../../catalog/application/get-topic.query';
import { type ServedCard } from '../../discovery/application/ports/card.reader';
import { ServedCardsQuery } from '../../discovery/application/served-cards.query';
import { StepCompleted } from '../domain';
import { type PathSummaryView, type PathView, stepView, type StepView, summaryView, type TopicRef } from './path.view';
import { PATH_REPOSITORY, type PathRepository, type PathStatus, type PathSummaryRecord, type StepPatch } from './ports/path.repository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const notFound = (): ProblemException => new ProblemException(404, 'NOT_FOUND', 'Not found');

/** `createdAt|id` of the last row, base64url (contract Cursor, at most 256 characters). */
export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(at ?? '');
  if (!id || !UUID.test(id) || Number.isNaN(createdAt.getTime())) {
    throw new ProblemException(400, 'VALIDATION_FAILED', 'Validation failed', { errors: [{ field: 'cursor', message: 'is not a cursor from this list' }] });
  }
  return { createdAt, id };
}

/** Reads (GET /v1/paths, GET /v1/paths/{id}) and step updates (PATCH /v1/steps/{id}), owner only. */
@Injectable()
export class PathsQueries {
  constructor(
    @Inject(PATH_REPOSITORY) private readonly repo: PathRepository,
    private readonly topics: GetTopicQuery,
    private readonly served: ServedCardsQuery,
    private readonly bus: EventBus,
  ) {}

  async list(userId: string, filter: { status?: PathStatus; topicId?: string; cursor?: string; limit: number }): Promise<{ items: PathSummaryView[]; nextCursor: string | null }> {
    if (filter.topicId !== undefined && !UUID.test(filter.topicId)) return { items: [], nextCursor: null };
    const rows = await this.repo.list(userId, {
      limit: filter.limit + 1,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.topicId ? { topicId: filter.topicId } : {}),
      ...(filter.cursor ? { before: decodeCursor(filter.cursor) } : {}),
    });
    const page = rows.slice(0, filter.limit);
    const topics = await this.topicRefs(page);
    const last = page.at(-1);
    return {
      items: page.map((p) => summaryView(p, topics.get(p.topicId) ?? { id: p.topicId })),
      nextCursor: rows.length > filter.limit && last ? encodeCursor(last) : null,
    };
  }

  /** 404 for someone else's path, and while it is generating (contract 0.10.0: follow the job instead). */
  async get(userId: string, pathId: string): Promise<PathView> {
    if (!UUID.test(pathId)) throw notFound();
    const summary = await this.repo.summary(userId, pathId);
    if (!summary || summary.status === 'generating') throw notFound();
    const steps = await this.repo.steps(pathId);
    const cards = await this.cards(summary.topicId, steps.flatMap((s) => s.resourceIds));
    const topics = await this.topicRefs([summary]);
    return { ...summaryView(summary, topics.get(summary.topicId) ?? { id: summary.topicId }), steps: steps.map((s) => stepView(s, cards)) };
  }

  async patchStep(userId: string, stepId: string, patch: StepPatch): Promise<StepView> {
    if (patch.actionsDone === undefined && patch.difficulty === undefined && patch.status === undefined) {
      throw new ProblemException(400, 'VALIDATION_FAILED', 'Validation failed', { errors: [{ field: 'body', message: 'set at least one of actionsDone, difficulty or status' }] });
    }
    if (!UUID.test(stepId)) throw notFound();
    const outcome = await this.repo.patchStep(userId, stepId, patch);
    if (outcome.kind === 'not_found') throw notFound();
    if (outcome.kind === 'not_active') {
      throw new ProblemException(400, 'VALIDATION_FAILED', 'Validation failed', { errors: [{ field: 'status', message: 'only the active step of an active path can be completed or skipped' }] });
    }
    if (patch.status) await this.bus.publish(new StepCompleted(outcome.step.pathId, outcome.step.id, userId, patch.status, outcome.pathCompleted));
    const path = await this.repo.findById(outcome.step.pathId);
    const cards = path ? await this.cards(path.topicId, outcome.step.resourceIds) : new Map<string, ServedCard>();
    return stepView(outcome.step, cards);
  }

  private async cards(topicId: string, resourceIds: string[]): Promise<Map<string, ServedCard>> {
    const cited = await this.served.cited(topicId, [...new Set(resourceIds)]);
    return new Map(cited.map((c) => [c.resourceId, c]));
  }

  private async topicRefs(rows: PathSummaryRecord[]): Promise<Map<string, TopicRef>> {
    const ids = [...new Set(rows.map((r) => r.topicId))];
    const found = await Promise.all(ids.map((id) => this.topics.execute(id)));
    return new Map(found.flatMap((t) => (t ? [[t.id, t as unknown as TopicRef] as const] : [])));
  }
}
