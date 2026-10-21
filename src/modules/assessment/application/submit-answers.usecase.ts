import { Inject, Injectable } from '@nestjs/common';
import { UnitOfWork } from '../../../shared/events';
import { type Answer, BatchMismatchError, isCorrect, submit } from '../domain/diagnostic';
import { PlacementComputed } from '../domain/events/placement-computed.event';
import { type DiagnosticBatchView, itemsView, placementView } from './diagnostic.view';
import { DiagnosticConflictError, DiagnosticNotFoundError, NotDiagnosticOwnerError } from './errors';
import { DIAGNOSTIC_REPOSITORY, type DiagnosticRepository, type ServedItem, type SessionRecord } from './ports/diagnostic.repository';

/** The outstanding batch of an open session, or just its progress once complete. */
export function currentView(session: SessionRecord, bank: ServedItem[]): DiagnosticBatchView {
  const byId = new Map(bank.map((s) => [s.item.id, s] as const));
  const items = session.state.engine.current.map((id) => byId.get(id)).filter((s): s is ServedItem => s !== undefined);
  return { diagnosticId: session.id, status: session.status, progress: session.state.progress, ...(session.status === 'in_progress' ? { items: itemsView(items) } : {}) };
}

export interface SubmitAnswersCommand {
  userId: string;
  diagnosticId: string;
  answers: (Answer & { text?: string })[];
}

/** POST /v1/diagnostics/:id/answers: grades the batch and returns the next batch or the placement. */
@Injectable()
export class SubmitDiagnosticAnswers {
  constructor(
    @Inject(DIAGNOSTIC_REPOSITORY) private readonly repo: DiagnosticRepository,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(command: SubmitAnswersCommand): Promise<DiagnosticBatchView> {
    const existing = await this.repo.findById(command.diagnosticId);
    if (!existing) throw new DiagnosticNotFoundError();
    if (existing.userId !== command.userId) throw new NotDiagnosticOwnerError();
    const bank = await this.repo.loadBank(existing.topicId);
    const items = bank.map((s) => s.item);
    const byId = new Map(bank.map((s) => [s.item.id, s] as const));

    return this.uow.run(async (tx, scope) => {
      const session = await this.repo.lock(tx, command.diagnosticId);
      if (!session) throw new DiagnosticNotFoundError();
      if (session.status === 'completed') throw new DiagnosticConflictError('This diagnostic is already complete');

      let step;
      try {
        step = submit(session.state.engine, command.answers, items);
      } catch (error) {
        if (error instanceof BatchMismatchError) throw new DiagnosticConflictError(error.message);
        throw error;
      }

      await this.repo.saveAnswers(
        tx,
        session.id,
        command.answers.map((a) => {
          const served = byId.get(a.itemId);
          const correct = served ? isCorrect(served.item, a) : false;
          return { itemId: a.itemId, answer: { optionIds: a.optionIds ?? [], text: a.text ?? null }, skipped: a.skipped ?? false, score: correct ? 100 : 0 };
        }),
      );
      await this.repo.update(tx, session.id, { engine: step.state, progress: step.progress }, step.done);

      if (!step.done) {
        const next = step.batch.map((i) => byId.get(i.id)).filter((s): s is ServedItem => s !== undefined);
        return { diagnosticId: session.id, status: 'in_progress', progress: step.progress, items: itemsView(next) };
      }
      const placementId = await this.repo.createPlacement(tx, {
        sessionId: session.id,
        userId: session.userId,
        topicId: session.topicId,
        placement: step.placement,
        basis: step.basis,
      });
      const { stage, bloom } = step.placement.position;
      scope.publish(new PlacementComputed(placementId, session.userId, session.topicId, stage, bloom, step.placement.confidence, step.basis));
      return { diagnosticId: session.id, status: 'completed', progress: step.progress, placement: placementView(placementId, step.placement) };
    });
  }
}
