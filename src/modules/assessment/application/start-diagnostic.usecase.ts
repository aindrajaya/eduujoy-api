import { Inject, Injectable } from '@nestjs/common';
import { UnitOfWork } from '../../../shared/events';
import { GetTopicQuery } from '../../catalog/application/get-topic.query';
import { begin, type SelfReport, startCell } from '../domain/diagnostic';
import { PlacementComputed } from '../domain/events/placement-computed.event';
import { type DiagnosticBatchView, itemsView, placementView } from './diagnostic.view';
import { TopicNotFoundError } from './errors';
import { DIAGNOSTIC_REPOSITORY, type DiagnosticRepository, type ServedItem } from './ports/diagnostic.repository';
import { currentView } from './submit-answers.usecase';

export interface StartDiagnosticCommand {
  userId: string;
  topicId: string;
  goal: string;
  weeklyHours: number;
  preferredFormats?: ('video' | 'text' | 'papers')[];
  selfReport?: SelfReport;
}

/** POST /v1/diagnostics: resumes an open diagnostic, or starts one (FR-03, FR-04, US-02). */
@Injectable()
export class StartDiagnostic {
  constructor(
    @Inject(DIAGNOSTIC_REPOSITORY) private readonly repo: DiagnosticRepository,
    private readonly topics: GetTopicQuery,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(command: StartDiagnosticCommand): Promise<DiagnosticBatchView> {
    const topic = await this.topics.execute(command.topicId);
    if (!topic) throw new TopicNotFoundError();

    const bank = await this.repo.loadBank(topic.id);
    const open = await this.repo.findOpen(command.userId, topic.id);
    if (open) return currentView(open, bank);

    const step = begin(startCell(command.selfReport), bank.map((s) => s.item));
    const created = await this.uow.run(async (tx, scope) => {
      const session = await this.repo.create(tx, {
        userId: command.userId,
        topicId: topic.id,
        goal: command.goal,
        weeklyHours: command.weeklyHours,
        preferredFormats: command.preferredFormats ?? [],
        selfReport: command.selfReport ?? null,
        state: { engine: step.state, progress: step.progress },
        completed: step.done,
      });
      if (!session) return null;
      if (!step.done) return { session, placementId: null };
      const placementId = await this.repo.createPlacement(tx, {
        sessionId: session.id,
        userId: command.userId,
        topicId: topic.id,
        placement: step.placement,
        basis: step.basis,
      });
      const { stage, bloom } = step.placement.position;
      scope.publish(new PlacementComputed(placementId, command.userId, topic.id, stage, bloom, step.placement.confidence, step.basis));
      return { session, placementId };
    });

    // Lost the race to a concurrent start: resume the session that won.
    if (!created) {
      const winner = await this.repo.findOpen(command.userId, topic.id);
      if (!winner) throw new Error('Concurrent diagnostic start left no open session');
      return currentView(winner, bank);
    }
    if (step.done) {
      return {
        diagnosticId: created.session.id,
        status: 'completed',
        progress: step.progress,
        placement: placementView(created.placementId ?? '', step.placement),
      };
    }
    const byId = new Map(bank.map((s) => [s.item.id, s] as const));
    const served = step.batch.map((item) => byId.get(item.id)).filter((s): s is ServedItem => s !== undefined);
    return { diagnosticId: created.session.id, status: 'in_progress', progress: step.progress, items: itemsView(served) };
  }
}
