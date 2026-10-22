import { EventEmitter2 } from '@nestjs/event-emitter';
import { type AccountDataContributor } from '../../../shared/common/account';
import { type Database } from '../../../shared/db/database';
import { EventBus } from '../../../shared/events/event-bus';
import { UnitOfWork } from '../../../shared/events/unit-of-work';
import { type JobRepository } from '../../../shared/jobs';
import { type GetSessionAuthTime } from '../../identity/application/get-session-auth-time.query';
import { DeleteAccount, REAUTH_WINDOW_MS } from './delete-account.usecase';
import { ReauthRequiredError, SessionGoneError } from './errors';
import { EXPORT_FORMAT, ExportAccount } from './export-account.usecase';

const NOW = new Date('2026-10-22T12:00:00Z');

function contributor(section: string, calls: string[]): AccountDataContributor {
  return {
    section,
    export: (userId) => Promise.resolve({ owner: userId }),
    erase: (_tx, userId, tombstone) => {
      calls.push(`${section}:${userId}:${tombstone.length}`);
      return Promise.resolve();
    },
  };
}

function setup(authTime: Date | null) {
  const calls: string[] = [];
  const db = { transaction: ((fn: (tx: never) => unknown) => fn({} as never)) as Database['transaction'] };
  const uow = new UnitOfWork(db, new EventBus(new EventEmitter2()));
  const jobs = { deleteForUser: (userId: string) => (calls.push(`jobs:${userId}`), Promise.resolve(0)) } as unknown as JobRepository;
  const authTimes = { execute: () => Promise.resolve(authTime) } as unknown as GetSessionAuthTime;
  const deleter = new DeleteAccount(authTimes, uow, jobs, contributor('billing', calls), contributor('account', calls));
  return { calls, deleter };
}

describe('DeleteAccount', () => {
  it('deletes within 10 minutes of the sign-in: billing anonymised first, then jobs, then identity', async () => {
    const t = setup(new Date(NOW.getTime() - REAUTH_WINDOW_MS));

    await t.deleter.execute('u1', 's1', NOW);

    // The tombstone is a UUID (36 chars), shared by the billing and identity steps.
    expect(t.calls).toEqual(['billing:u1:36', 'jobs:u1', 'account:u1:36']);
  });

  it('asks for a fresh sign-in once the window has passed, and deletes nothing', async () => {
    const t = setup(new Date(NOW.getTime() - REAUTH_WINDOW_MS - 1));

    await expect(t.deleter.execute('u1', 's1', NOW)).rejects.toBeInstanceOf(ReauthRequiredError);
    expect(t.calls).toEqual([]);
  });

  it('refuses an unknown or revoked session', async () => {
    const t = setup(null);
    await expect(t.deleter.execute('u1', 's1', NOW)).rejects.toBeInstanceOf(SessionGoneError);
    expect(t.calls).toEqual([]);
  });
});

describe('ExportAccount', () => {
  it('collects every module section for that learner only', async () => {
    const calls: string[] = [];
    const sections = ['account', 'assessment', 'progress', 'billing', 'topicsCreated'].map((s) => contributor(s, calls));
    const [identity, assessment, progress, billing, catalog] = sections as [AccountDataContributor, AccountDataContributor, AccountDataContributor, AccountDataContributor, AccountDataContributor];

    const data = await new ExportAccount(identity, assessment, progress, billing, catalog).execute('u1');

    expect(data).toMatchObject({
      format: EXPORT_FORMAT,
      account: { owner: 'u1' },
      assessment: { owner: 'u1' },
      progress: { owner: 'u1' },
      billing: { owner: 'u1' },
      topicsCreated: { owner: 'u1' },
    });
    expect(typeof data['exportedAt']).toBe('string');
  });
});
