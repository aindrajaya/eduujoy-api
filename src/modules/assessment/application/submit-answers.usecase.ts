import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { UnitOfWork } from '../../../shared/events';
import { type Answer, BatchMismatchError, isCorrect, submit } from '../domain/diagnostic';
import { PlacementComputed } from '../domain/events/placement-computed.event';
import { type DiagnosticBatchView, itemsView, placementView } from './diagnostic.view';
import { DiagnosticConflictError, DiagnosticNotFoundError } from './errors';
import { isUuid } from './ids';
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
  /** Optional `Idempotency-Key` (contract 0.3.0-v0); retries of one batch reuse it. */
  idempotencyKey?: string;
}

/** Hash of the diagnostic id and body, with fields in a fixed order so equal bodies hash equal. */
export function answersRequestHash(command: SubmitAnswersCommand): string {
  const body = command.answers.map((a) => [a.itemId, a.optionIds ?? null, a.skipped ?? null, a.text ?? null]);
  return createHash('sha256').update(JSON.stringify([command.diagnosticId, body])).digest('hex');
}

/** POST /v1/diagnostics/:id/answers: grades the batch and returns the next batch or the placement. */
@Injectable()
export class SubmitDiagnosticAnswers {
  constructor(
    @Inject(DIAGNOSTIC_REPOSITORY) private readonly repo: DiagnosticRepository,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(command: SubmitAnswersCommand): Promise<DiagnosticBatchView> {
    // Someone else's diagnostic is 404, as on GET, so ids aren't probeable.
    const existing = isUuid(command.diagnosticId) ? await this.repo.findById(command.diagnosticId) : null;
    if (!existing || existing.userId !== command.userId) throw new DiagnosticNotFoundError();
    const bank = await this.repo.loadBank(existing.topicId);
    const items = bank.map((s) => s.item);
    const byId = new Map(bank.map((s) => [s.item.id, s] as const));

    return this.uow.run(async (tx, scope) => {
      const session = await this.repo.lock(tx, command.diagnosticId);
      if (!session) throw new DiagnosticNotFoundError();

      const key = command.idempotencyKey;
      const requestHash = key === undefined ? '' : answersRequestHash(command);
      if (key !== undefined) {
        // Checked under the session lock, so a concurrent retry waits and then replays.
        const replay = await this.repo.findReplay(tx, command.userId, key);
        if (replay) {
          if (replay.requestHash !== requestHash) throw new DiagnosticConflictError('This Idempotency-Key was used with a different request');
          return replay.response;
        }
      }
      const remember = async (response: DiagnosticBatchView): Promise<DiagnosticBatchView> => {
        if (key === undefined) return response;
        const saved = await this.repo.saveReplay(tx, { userId: command.userId, idempotencyKey: key, sessionId: session.id, requestHash, response });
        if (!saved) throw new DiagnosticConflictError('This Idempotency-Key was used with a different request');
        return response;
      };

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
        return remember({ diagnosticId: session.id, status: 'in_progress', progress: step.progress, items: itemsView(next) });
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
      return remember({ diagnosticId: session.id, status: 'completed', progress: step.progress, placement: placementView(placementId, step.placement) });
    });
  }
}
