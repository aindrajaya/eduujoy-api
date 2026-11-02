import { conceptMatches } from '../../../shared/common/concept-map';
import { MIN_SERVED_CARDS, pageKind, type ServableCard, servedCards, serveDrop } from '../domain';

// Titles and URLs are real served cards from the dev pools (3 Nov 2026).
describe('pageKind', () => {
  it.each([
    ['Reference', 'https://kubernetes.io/docs/reference', 'index'],
    ['Reference', 'https://v1-36.docs.kubernetes.io/docs/reference', 'index'],
    ['Reference', 'https://www.kubernetes.ltd/docs/reference', 'index'],
    ['Tutorials', 'https://kubernetes.io/docs/tutorials', 'index'],
    ['Our Documentation', 'https://www.python.org/doc', 'index'],
    ['Kubernetes API Reference Docs', 'https://pwittrock.github.io/docs/api-reference/v1.7', 'index'],
    ['Kubernetes - Reference Documentation', 'https://jamesdefabia.github.io/docs/reference', 'index'],
    ['Introduction to Public Speaking', 'https://www.coursera.org/learn/public-speaking', 'course_landing'],
    ['Become a confident Public Speaker with this free online course', 'https://alison.com/course/public-speaking', 'course_landing'],
    ['User Research Methods and Practices', 'https://www.coursera.org/learn/user-research-methods-and-practices-iitg', 'course_landing'],
    ['Exploring Public Speaking - 4th Edition - Open Textbook Library', 'https://open.umn.edu/opentextbooks/textbooks/1652', 'catalogue'],
    ['Understanding Machine Learning - Open Tech Book', 'https://opentechbook.com/book/understanding-machine-learning', 'catalogue'],
  ])('%s (%s) is %s', (title, url, kind) => {
    expect(pageKind(title, url)).toBe(kind);
  });

  it.each([
    ['Deployments', 'https://kubernetes.io/docs/concepts/workloads/controllers/deployment'],
    ['Learn Kubernetes Basics', 'https://kubernetes.io/docs/tutorials/kubernetes-basics'],
    ['The Python Tutorial — Python 3.15.2 documentation', 'https://docs.python.org/3/tutorial/index.html'],
    ['User Guide — scikit-learn 1.9.1 documentation', 'https://scikit-learn.org/stable/user_guide.html'],
    ['SQL', 'https://en.wikipedia.org/wiki/SQL'],
    ['Python Exercises Online', 'https://pychallenger.com/'],
    ['Exploring Public Speaking', 'https://www.exploringpublicspeaking.com/'],
    ['Machine Learning  |  Google for Developers', 'https://developers.google.com/machine-learning/crash-course'],
    ['not a url', 'nope'],
  ])('%s (%s) is material', (title, url) => {
    expect(pageKind(title, url)).toBeNull();
  });
});

const card = (title: string, stage: ServableCard['stage'], relevance: number, concepts: string[] = [], url = `https://example.com/${encodeURIComponent(title)}`): ServableCard => ({
  title,
  url,
  stage,
  quality: { relevance },
  concepts: concepts.map((name) => ({ name })),
});

describe('serveDrop', () => {
  const names = ['Deployments', 'Services', 'Rolling updates'];

  it('drops a card two or more stages below the pool (real: novice overviews in the competent pool)', () => {
    expect(serveDrop(card('Kubernetes Simply Explained', 'novice', 80, ['Deployments']), 'competent', names, conceptMatches)).toBe('stage');
    expect(serveDrop(card('Kubernetes Best Practices and how to enforce them with Datree', 'advanced_beginner', 80, ['Deployments']), 'competent', names, conceptMatches)).toBeNull();
  });

  it('applies the relevance floor, and the map test only below strong relevance', () => {
    expect(serveDrop(card('Deployments', 'competent', 65, ['Deployments']), 'competent', names, conceptMatches)).toBe('relevance');
    expect(serveDrop(card('A survey of scheduling', 'competent', 75, ['Scheduling algorithms']), 'competent', names, conceptMatches)).toBe('off_map');
    expect(serveDrop(card('A survey of scheduling', 'competent', 88, ['Scheduling algorithms']), 'competent', names, conceptMatches)).toBeNull();
    // Lexical match: containment counts (plural or stem variants alone do not; the matcher is a floor).
    expect(serveDrop(card('Rolling updates in practice', 'competent', 75, ['Rolling updates and rollbacks']), 'competent', names, conceptMatches)).toBeNull();
    // No map: no map test.
    expect(serveDrop(card('A survey of scheduling', 'competent', 75, ['Scheduling algorithms']), 'competent', null, conceptMatches)).toBeNull();
  });

  it('drops page kinds first', () => {
    expect(serveDrop(card('Reference', 'competent', 95, ['Deployments'], 'https://kubernetes.io/docs/reference'), 'competent', names, conceptMatches)).toBe('page_kind');
  });
});

describe('servedCards', () => {
  it('counts each drop and keeps the pool order', () => {
    const cards = [card('A', 'competent', 90), card('B', 'novice', 90), card('C', 'competent', 60), ...[1, 2, 3, 4, 5, 6].map((n) => card(`K${n}`, 'competent', 90))];
    const out = servedCards(cards, 'competent', null, conceptMatches);
    expect(out.cards.map((c) => c.title)).toEqual(['A', 'K1', 'K2', 'K3', 'K4', 'K5', 'K6']);
    expect(out.dropped).toEqual({ relevance: 1, off_map: 0, stage: 1, page_kind: 0 });
    expect(out.flagged).toBe(false);
  });

  it(`refills a pool under ${MIN_SERVED_CARDS} from its best dropped cards, never page kinds, and flags it`, () => {
    const cards = [
      card('Reference', 'competent', 99, [], 'https://kubernetes.io/docs/reference'),
      card('Low', 'competent', 50),
      card('Old', 'novice', 80),
      card('K1', 'competent', 90),
      card('K2', 'competent', 90),
      card('K3', 'competent', 90),
    ];
    const out = servedCards(cards, 'competent', null, conceptMatches);
    expect(out.cards.map((c) => c.title)).toEqual(['Low', 'Old', 'K1', 'K2', 'K3']);
    expect(out).toMatchObject({ refilled: 2, flagged: true });
  });
});
