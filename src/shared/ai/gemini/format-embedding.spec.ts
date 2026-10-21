import { formatEmbeddingInput } from './gemini.adapters';

describe('formatEmbeddingInput (gemini-embedding-2 prefixes)', () => {
  it('prefixes queries with the search-result task', () => {
    expect(formatEmbeddingInput({ texts: ['react hooks'], kind: 'query' })).toEqual(['task: search result | query: react hooks']);
  });

  it('prefixes documents with their title, or "none" when missing or blank', () => {
    expect(
      formatEmbeddingInput({ texts: ['a', 'b', 'c'], kind: 'document', titles: ['React hooks', null, '  '] }),
    ).toEqual(['title: React hooks | text: a', 'title: none | text: b', 'title: none | text: c']);
    expect(formatEmbeddingInput({ texts: ['d'], kind: 'document' })).toEqual(['title: none | text: d']);
  });
});
