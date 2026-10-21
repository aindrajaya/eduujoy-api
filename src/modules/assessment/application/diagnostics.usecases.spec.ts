import { randomUUID } from 'node:crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { type Database } from '../../../shared/db/database';
import { EventBus } from '../../../shared/events/event-bus';
import { UnitOfWork } from '../../../shared/events/unit-of-work';
import { type GetTopicQuery } from '../../catalog/application/get-topic.query';
import { LADDER } from '../domain/diagnostic';
import { type PlacementComputed } from '../domain/events/placement-computed.event';
import { DiagnosticConflictError, DiagnosticNotFoundError, NotDiagnosticOwnerError, TopicNotFoundError } from './errors';
import { GetDiagnostic } from './get-diagnostic.query';
import { type DiagnosticRepository, type NewSession, type PlacementRecord, type ServedItem, type SessionRecord } from './ports/diagnostic.repository';
import { StartDiagnostic } from './start-diagnostic.usecase';
import { SubmitDiagnosticAnswers } from './submit-answers.usecase';

const TOPIC = { id: '0b1c6a1e-7f43-4c3c-9d39-5f2f6a1f0a11', canonicalName: 'React hooks', aliases: [], parentId: null, description: null };

class FakeRepo implements DiagnosticRepository {
  bank: ServedItem[] = LADDER.flatMap((cell, c) =>
    [1, 2, 3].map((n) => ({
      item: { id: `c${c}-${n}`, cell: c, kind: 'single_choice' as const, answerKey: ['b'], reviewed: true },
      bloom: cell.bloom,
      prompt: `Q ${c}-${n}`,
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
    })),
  );
  sessions = new Map<string, SessionRecord>();
  placements = new Map<string, PlacementRecord & { basis: string }>();
  answers: { sessionId: string; itemId: string; score: number }[] = [];
  raceOnCreate = false;

  loadBank(): Promise<ServedItem[]> {
    return Promise.resolve(this.bank);
  }
  findById(id: string): Promise<SessionRecord | null> {
    return Promise.resolve(this.sessions.get(id) ?? null);
  }
  findOpen(userId: string, topicId: string): Promise<SessionRecord | null> {
    return Promise.resolve([...this.sessions.values()].find((s) => s.userId === userId && s.topicId === topicId && s.status === 'in_progress') ?? null);
  }
  create(_tx: never, session: NewSession): Promise<SessionRecord | null> {
    const record: SessionRecord = {
      id: randomUUID(),
      userId: session.userId,
      topicId: session.topicId,
      status: session.completed ? 'completed' : 'in_progress',
      state: session.state,
      createdAt: new Date(),
      completedAt: session.completed ? new Date() : null,
    };
    if (this.raceOnCreate) {
      this.raceOnCreate = false;
      this.sessions.set(record.id, record);
      return Promise.resolve(null);
    }
    this.sessions.set(record.id, record);
    return Promise.resolve(record);
  }
  lock(_tx: never, id: string): Promise<SessionRecord | null> {
    return this.findById(id);
  }
  saveAnswers(_tx: never, sessionId: string, answers: { itemId: string; score: number }[]): Promise<void> {
    this.answers.push(...answers.map((a) => ({ sessionId, itemId: a.itemId, score: a.score })));
    return Promise.resolve();
  }
  update(_tx: never, id: string, state: SessionRecord['state'], completed: boolean): Promise<void> {
    const s = this.sessions.get(id);
    if (s) this.sessions.set(id, { ...s, state, status: completed ? 'completed' : 'in_progress', completedAt: completed ? new Date() : null });
    return Promise.resolve();
  }
  createPlacement(_tx: never, input: { sessionId: string; placement: PlacementRecord['placement']; basis: string }): Promise<string> {
    const id = randomUUID();
    this.placements.set(input.sessionId, { id, placement: input.placement, basis: input.basis });
    return Promise.resolve(id);
  }
  findPlacement(sessionId: string): Promise<PlacementRecord | null> {
    return Promise.resolve(this.placements.get(sessionId) ?? null);
  }
}

function setup() {
  const repo = new FakeRepo();
  const events: PlacementComputed[] = [];
  const bus = new EventBus(new EventEmitter2());
  bus.on<PlacementComputed>('PlacementComputed', (e) => events.push(e));
  const db = { transaction: ((fn: (tx: never) => unknown) => fn({} as never)) as Database['transaction'] };
  const uow = new UnitOfWork(db, bus);
  const topics = { execute: (id: string) => Promise.resolve(id === TOPIC.id ? TOPIC : null) } as unknown as GetTopicQuery;
  return {
    repo,
    events,
    start: new StartDiagnostic(repo, topics, uow),
    submit: new SubmitDiagnosticAnswers(repo, uow),
    get: new GetDiagnostic(repo, topics),
  };
}

const startCommand = (userId = 'u1') => ({ userId, topicId: TOPIC.id, goal: 'Build a dashboard', weeklyHours: 5, selfReport: { projectsShipped: 3 } });

describe('StartDiagnostic', () => {
  it('starts at the self-report cell with 4 items and never exposes answer keys', async () => {
    const t = setup();

    const view = await t.start.execute(startCommand());

    expect(view).toMatchObject({ status: 'in_progress', progress: { answered: 0, estimatedTotal: 8 } });
    expect(view.items?.map((i) => i.id)).toEqual(['c4-1', 'c4-2', 'c5-1', 'c3-1']);
    expect(JSON.stringify(view)).not.toContain('answerKey');
  });

  it('resumes the open diagnostic instead of starting a second one', async () => {
    const t = setup();
    const first = await t.start.execute(startCommand());

    const again = await t.start.execute(startCommand());

    expect(again.diagnosticId).toBe(first.diagnosticId);
    expect(t.repo.sessions.size).toBe(1);
  });

  it('resumes the winner when a concurrent start took the slot first', async () => {
    const t = setup();
    t.repo.raceOnCreate = true;

    const view = await t.start.execute(startCommand());

    expect(view.status).toBe('in_progress');
    expect(t.repo.sessions.size).toBe(1);
  });

  it('rejects an unknown topic', async () => {
    await expect(setup().start.execute({ ...startCommand(), topicId: 'nope' })).rejects.toBeInstanceOf(TopicNotFoundError);
  });

  it('places from the self-report at once when the topic has no bank, flagged and published after commit', async () => {
    const t = setup();
    t.repo.bank = [];

    const view = await t.start.execute(startCommand());

    expect(view).toMatchObject({ status: 'completed', placement: { position: { stage: 'competent', bloom: 'C3' }, confidence: 0.3 } });
    expect([...t.repo.placements.values()][0]?.basis).toBe('self_report');
    expect(t.events).toEqual([expect.objectContaining({ userId: 'u1', topicId: TOPIC.id, stage: 'competent', bloom: 'C3', basis: 'self_report' })]);
  });
});

describe('SubmitDiagnosticAnswers', () => {
  it('grades the batch, serves the next one, and completes with a placement and event', async () => {
    const t = setup();
    let view = await t.start.execute(startCommand());
    while (view.status === 'in_progress') {
      const answers = (view.items ?? []).map((i) => ({ itemId: i.id, optionIds: [Number(i.id.slice(1, i.id.indexOf('-'))) <= 5 ? 'b' : 'a'] }));
      view = await t.submit.execute({ userId: 'u1', diagnosticId: view.diagnosticId, answers });
    }

    expect(view.placement).toMatchObject({ position: { stage: 'competent', bloom: 'C4' } });
    expect(t.events).toHaveLength(1);
    expect(t.repo.answers.length).toBe(view.progress.answered);
    expect(t.repo.answers.some((a) => a.score === 100)).toBe(true);
  });

  it('refuses another user, a finished diagnostic and answers that do not match the batch', async () => {
    const t = setup();
    const view = await t.start.execute(startCommand());
    const answers = (view.items ?? []).map((i) => ({ itemId: i.id, optionIds: ['b'] }));

    await expect(t.submit.execute({ userId: 'intruder', diagnosticId: view.diagnosticId, answers })).rejects.toBeInstanceOf(NotDiagnosticOwnerError);
    await expect(t.submit.execute({ userId: 'u1', diagnosticId: view.diagnosticId, answers: answers.slice(1) })).rejects.toBeInstanceOf(
      DiagnosticConflictError,
    );
    await expect(t.submit.execute({ userId: 'u1', diagnosticId: randomUUID(), answers })).rejects.toBeInstanceOf(DiagnosticNotFoundError);

    const session = t.repo.sessions.get(view.diagnosticId);
    if (session) t.repo.sessions.set(session.id, { ...session, status: 'completed' });
    await expect(t.submit.execute({ userId: 'u1', diagnosticId: view.diagnosticId, answers })).rejects.toThrow('already complete');
  });
});

describe('GetDiagnostic', () => {
  it('returns the outstanding batch with topic and timestamps to the owner only', async () => {
    const t = setup();
    const view = await t.start.execute(startCommand());

    const detail = await t.get.execute('u1', view.diagnosticId);

    expect(detail).toMatchObject({ diagnosticId: view.diagnosticId, status: 'in_progress', topic: TOPIC, completedAt: null });
    expect(detail.items).toHaveLength(4);
    await expect(t.get.execute('intruder', view.diagnosticId)).rejects.toBeInstanceOf(DiagnosticNotFoundError);
    await expect(t.get.execute('u1', 'not-a-uuid')).rejects.toBeInstanceOf(DiagnosticNotFoundError);
  });
});
