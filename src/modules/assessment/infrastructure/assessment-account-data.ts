import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { type AccountDataContributor } from '../../../shared/common/account';
import { DATABASE, type Database } from '../../../shared/db';
import { checkpointAttempts, checkpointSubmissions, diagnosticAnswers, diagnosticSessions, placements } from '../../../shared/db/schema/assessment';

/** Diagnostics, answers, placements and checkpoint work. Item answer keys are never included. */
@Injectable()
export class AssessmentAccountData implements AccountDataContributor {
  readonly section = 'assessment';

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async export(userId: string): Promise<unknown> {
    const diagnostics = await this.db
      .select({
        id: diagnosticSessions.id,
        topicId: diagnosticSessions.topicId,
        goal: diagnosticSessions.goal,
        weeklyHours: diagnosticSessions.weeklyHours,
        preferredFormats: diagnosticSessions.preferredFormats,
        selfReport: diagnosticSessions.selfReport,
        status: diagnosticSessions.status,
        createdAt: diagnosticSessions.createdAt,
        completedAt: diagnosticSessions.completedAt,
      })
      .from(diagnosticSessions)
      .where(eq(diagnosticSessions.userId, userId))
      .orderBy(asc(diagnosticSessions.createdAt));
    const answers = await this.db
      .select({ diagnosticId: diagnosticAnswers.sessionId, itemId: diagnosticAnswers.itemId, answer: diagnosticAnswers.answer, skipped: diagnosticAnswers.skipped, score: diagnosticAnswers.score, createdAt: diagnosticAnswers.createdAt })
      .from(diagnosticAnswers)
      .innerJoin(diagnosticSessions, eq(diagnosticSessions.id, diagnosticAnswers.sessionId))
      .where(eq(diagnosticSessions.userId, userId))
      .orderBy(asc(diagnosticAnswers.createdAt));
    const placed = await this.db
      .select({ id: placements.id, diagnosticId: placements.sessionId, topicId: placements.topicId, stage: placements.stage, bloom: placements.bloom, confidence: placements.confidence, reason: placements.reason, basis: placements.basis, createdAt: placements.createdAt })
      .from(placements)
      .where(eq(placements.userId, userId))
      .orderBy(asc(placements.createdAt));
    const submissions = await this.db
      .select({ id: checkpointSubmissions.id, stepId: checkpointSubmissions.stepId, answers: checkpointSubmissions.answers, status: checkpointSubmissions.status, score: checkpointSubmissions.score, createdAt: checkpointSubmissions.createdAt, gradedAt: checkpointSubmissions.gradedAt })
      .from(checkpointSubmissions)
      .where(eq(checkpointSubmissions.userId, userId))
      .orderBy(asc(checkpointSubmissions.createdAt));
    const attempts = await this.db
      .select({ stepId: checkpointAttempts.stepId, submissionId: checkpointAttempts.submissionId, answer: checkpointAttempts.answer, score: checkpointAttempts.score, passed: checkpointAttempts.passed, feedback: checkpointAttempts.feedback, createdAt: checkpointAttempts.createdAt })
      .from(checkpointAttempts)
      .where(eq(checkpointAttempts.userId, userId))
      .orderBy(asc(checkpointAttempts.createdAt));
    return { diagnostics, diagnosticAnswers: answers, placements: placed, checkpointSubmissions: submissions, checkpointAttempts: attempts };
  }
}
