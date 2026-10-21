import { GetTopicQuery } from './get-topic.query';
import { type TopicRepository } from './ports/topic.repository';

describe('GetTopicQuery', () => {
  const topic = { id: '0b1c6a1e-7f43-4c3c-9d39-5f2f6a1f0a11', canonicalName: 'React hooks', aliases: [], parentId: null, description: null };
  const repo: TopicRepository & { calls: string[] } = {
    calls: [],
    findById(id) {
      this.calls.push(id);
      return Promise.resolve(id === topic.id ? topic : null);
    },
  };

  it('looks well-formed ids up and returns the topic or null', async () => {
    const query = new GetTopicQuery(repo);

    await expect(query.execute(topic.id)).resolves.toEqual(topic);
    await expect(query.execute('11111111-1111-4111-8111-111111111111')).resolves.toBeNull();
  });

  it('never queries for malformed ids', async () => {
    repo.calls.length = 0;

    await expect(new GetTopicQuery(repo).execute("1' or '1'='1")).resolves.toBeNull();
    expect(repo.calls).toEqual([]);
  });
});
