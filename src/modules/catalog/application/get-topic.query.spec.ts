import { FakeTopicRepository } from './catalog.fakes';
import { GetTopicQuery } from './get-topic.query';

describe('GetTopicQuery', () => {
  it('looks well-formed ids up and returns the topic or null', async () => {
    const repo = new FakeTopicRepository();
    const topic = repo.add({ slug: 'react-hooks', canonicalName: 'React hooks' });
    const query = new GetTopicQuery(repo);

    await expect(query.execute(topic.id)).resolves.toEqual({ id: topic.id, canonicalName: 'React hooks', aliases: [], parentId: null, description: null });
    await expect(query.execute('11111111-1111-4111-8111-111111111111')).resolves.toBeNull();
  });

  it('never queries for malformed ids', async () => {
    const repo = new FakeTopicRepository();

    await expect(new GetTopicQuery(repo).execute("1' or '1'='1")).resolves.toBeNull();
    expect(repo.findByIdCalls).toEqual([]);
  });
});
