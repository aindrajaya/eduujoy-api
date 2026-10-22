import { FakeTopicRepository } from './catalog.fakes';
import { GetTopicProfileQuery } from './get-topic-profile.query';

describe('GetTopicProfileQuery', () => {
  it('returns the topic with its domain, or null for unknown and malformed ids', async () => {
    const repo = new FakeTopicRepository();
    const topic = repo.add({ slug: 'react-hooks', canonicalName: 'React hooks', domain: 'software' });
    const query = new GetTopicProfileQuery(repo);

    await expect(query.execute(topic.id)).resolves.toMatchObject({ id: topic.id, canonicalName: 'React hooks', domain: 'software' });
    await expect(query.execute('11111111-1111-4111-8111-111111111111')).resolves.toBeNull();
    await expect(query.execute('not-a-uuid')).resolves.toBeNull();
  });
});
