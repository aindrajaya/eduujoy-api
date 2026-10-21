import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DATABASE, type Database, type Tx } from '../../../shared/db';
import { diagnosticAnswers, diagnosticItems, diagnosticSessions, placements } from '../../../shared/db/schema/assessment';
import {
  type DiagnosticRepository,
  type NewSession,
  type PlacementRecord,
  type ServedItem,
  type SessionRecord,
  type StoredState,
} from '../application/ports/diagnostic.repository';
import { cellAt, cellIndex, type Placement } from '../domain/diagnostic';

// Item bodies come from seed files or reviewers; anything malformed is skipped, never served.
const bodySchema = z.object({
  prompt: z.string().min(1),
  options: z.array(z.object({ id: z.string().min(1), label: z.string().min(1) })).min(2),
  answerKey: z.object({ optionIds: z.array(z.string().min(1)).min(1) }),
});

const stateSchema = z.object({
  engine: z.object({
    estimate: z.number().int(),
    current: z.array(z.string()),
    served: z.array(z.string()),
    results: z.array(z.object({ itemId: z.string(), cell: z.number().int(), correct: z.boolean() })),
    estimates: z.array(z.number().int()),
  }),
  progress: z.object({ answered: z.number().int(), estimatedTotal: z.number().int() }),
});

type SessionRow = typeof diagnosticSessions.$inferSelect;

@Injectable()
export class DrizzleDiagnosticRepository implements DiagnosticRepository {
  private readonly logger = new Logger(DrizzleDiagnosticRepository.name);

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async loadBank(topicId: string): Promise<ServedItem[]> {
    const rows = await this.db
      .select()
      .from(diagnosticItems)
      .where(and(eq(diagnosticItems.topicId, topicId), ne(diagnosticItems.kind, 'short_answer')));
    const served: ServedItem[] = [];
    for (const row of rows) {
      const cell = cellIndex(row.stage, row.bloom);
      const body = bodySchema.safeParse(row.body);
      if (cell < 0 || !body.success || row.kind === 'short_answer') {
        this.logger.warn({ itemId: row.id }, 'Skipping a diagnostic item that is malformed or outside its stage band');
        continue;
      }
      served.push({
        item: { id: row.id, cell, kind: row.kind, answerKey: body.data.answerKey.optionIds, reviewed: row.reviewed },
        bloom: row.bloom,
        prompt: body.data.prompt,
        options: body.data.options,
      });
    }
    return served;
  }

  async findById(id: string): Promise<SessionRecord | null> {
    const [row] = await this.db.select().from(diagnosticSessions).where(eq(diagnosticSessions.id, id));
    return row ? toRecord(row) : null;
  }

  async findOpen(userId: string, topicId: string): Promise<SessionRecord | null> {
    const [row] = await this.db
      .select()
      .from(diagnosticSessions)
      .where(and(eq(diagnosticSessions.userId, userId), eq(diagnosticSessions.topicId, topicId), eq(diagnosticSessions.status, 'in_progress')));
    return row ? toRecord(row) : null;
  }

  async create(tx: Tx, session: NewSession): Promise<SessionRecord | null> {
    const [row] = await tx
      .insert(diagnosticSessions)
      .values({
        userId: session.userId,
        topicId: session.topicId,
        goal: session.goal,
        weeklyHours: session.weeklyHours,
        preferredFormats: session.preferredFormats,
        selfReport: session.selfReport,
        state: session.state,
        status: session.completed ? 'completed' : 'in_progress',
        completedAt: session.completed ? sql`now()` : null,
      })
      // diagnostic_sessions_open_key: a concurrent start already holds the open slot.
      .onConflictDoNothing()
      .returning();
    return row ? toRecord(row) : null;
  }

  async lock(tx: Tx, id: string): Promise<SessionRecord | null> {
    const [row] = await tx.select().from(diagnosticSessions).where(eq(diagnosticSessions.id, id)).for('update');
    return row ? toRecord(row) : null;
  }

  async saveAnswers(tx: Tx, sessionId: string, answers: { itemId: string; answer: unknown; skipped: boolean; score: number }[]): Promise<void> {
    if (answers.length === 0) return;
    await tx.insert(diagnosticAnswers).values(answers.map((a) => ({ sessionId, itemId: a.itemId, answer: a.answer, skipped: a.skipped, score: a.score })));
  }

  async update(tx: Tx, id: string, state: StoredState, completed: boolean): Promise<void> {
    await tx
      .update(diagnosticSessions)
      .set({ state, ...(completed ? { status: 'completed' as const, completedAt: sql`now()` } : {}) })
      .where(eq(diagnosticSessions.id, id));
  }

  async createPlacement(
    tx: Tx,
    input: { sessionId: string; userId: string; topicId: string; placement: Placement; basis: 'items' | 'self_report' },
  ): Promise<string> {
    const [row] = await tx
      .insert(placements)
      .values({
        sessionId: input.sessionId,
        userId: input.userId,
        topicId: input.topicId,
        stage: input.placement.position.stage,
        bloom: input.placement.position.bloom,
        confidence: input.placement.confidence,
        reason: input.placement.reason,
        basis: input.basis,
      })
      .returning({ id: placements.id });
    if (!row) throw new Error('Placement insert returned no row');
    return row.id;
  }

  async findPlacement(sessionId: string): Promise<PlacementRecord | null> {
    const [row] = await this.db.select().from(placements).where(eq(placements.sessionId, sessionId));
    if (!row) return null;
    const cell = Math.max(0, cellIndex(row.stage, row.bloom));
    // `real` is float4; round back to the 2 decimals the placement was computed with.
    const confidence = Math.round(row.confidence * 100) / 100;
    return { id: row.id, placement: { cell, position: cellAt(cell), confidence, reason: row.reason } };
  }
}

function toRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.userId,
    topicId: row.topicId,
    status: row.status,
    state: stateSchema.parse(row.state),
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}
