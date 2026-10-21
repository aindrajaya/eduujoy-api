import { Inject, Injectable } from '@nestjs/common';
import { GetTopicQuery } from '../../catalog/application/get-topic.query';
import { type TopicView } from '../../catalog/application/ports/topic.repository';
import { type DiagnosticBatchView, placementView } from './diagnostic.view';
import { DiagnosticNotFoundError } from './errors';
import { isUuid } from './ids';
import { DIAGNOSTIC_REPOSITORY, type DiagnosticRepository } from './ports/diagnostic.repository';
import { currentView } from './submit-answers.usecase';

/** Contract DiagnosticResponse (0.2.0): the batch shape plus topic and timestamps. */
export interface DiagnosticDetailView extends DiagnosticBatchView {
  topic: TopicView;
  createdAt: Date;
  completedAt: Date | null;
}


/** GET /v1/diagnostics/:id: owner only; anyone else gets 404, so ids can't be probed. */
@Injectable()
export class GetDiagnostic {
  constructor(
    @Inject(DIAGNOSTIC_REPOSITORY) private readonly repo: DiagnosticRepository,
    private readonly topics: GetTopicQuery,
  ) {}

  async execute(userId: string, diagnosticId: string): Promise<DiagnosticDetailView> {
    const session = isUuid(diagnosticId) ? await this.repo.findById(diagnosticId) : null;
    if (!session || session.userId !== userId) throw new DiagnosticNotFoundError();
    const topic = await this.topics.execute(session.topicId);
    if (!topic) throw new DiagnosticNotFoundError();
    const base = currentView(session, session.status === 'in_progress' ? await this.repo.loadBank(session.topicId) : []);
    const placement = session.status === 'completed' ? await this.repo.findPlacement(session.id) : null;
    return {
      ...base,
      ...(placement ? { placement: placementView(placement.id, placement.placement) } : {}),
      topic,
      createdAt: session.createdAt,
      completedAt: session.completedAt,
    };
  }
}
