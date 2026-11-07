import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { conceptMapSchema, conceptMatches, namesNearStage } from '../../../shared/common/concept-map';
import { MIN_SERVED_CARDS, pageKind, type ServableCard, servedCards, serveDrop, youtubeIdFromUrl } from '../domain';

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

// Real held and served cards from the dev pools (ep-noisy-mouse, 4 Nov 2026), with the real maps.
const realMap = (slug: string) => conceptMapSchema.parse(JSON.parse(readFileSync(join(__dirname, '..', '..', '..', '..', 'seed', 'concept-maps', `${slug}.json`), 'utf8')));

describe('serveDrop: stage (2+ stages below the pool)', () => {
  const names = namesNearStage(realMap('kubernetes'), 'competent');

  it('holds a novice overview in the competent pool, keeps an advanced-beginner card', () => {
    expect(serveDrop(card('Kubernetes Simply Explained', 'novice', 80, ['Kubernetes architecture']), 'competent', names, conceptMatches)).toBe('stage');
    expect(serveDrop(card('Kubernetes Explained in 6 Minutes | k8s Architecture', 'novice', 82, []), 'competent', names, conceptMatches)).toBe('stage');
    expect(serveDrop(card('Kubernetes Best Practices and how to enforce them with Datree', 'advanced_beginner', 80, ['Resource requests and limits']), 'competent', names, conceptMatches)).not.toBe('stage');
  });
});

describe('serveDrop: relevance (< 70)', () => {
  it('holds "Data Storytelling 101" (relevance 45) in the statistics competent pool', () => {
    const c = card('Data Storytelling 101 | Think Like a Data Analyst', 'advanced_beginner', 45, ['Data Visualization vs. Data Storytelling', 'Exploratory Slicing by Dimensions'], 'https://www.youtube.com/watch?v=H79S8YDuYUU');
    expect(serveDrop(c, 'competent', namesNearStage(realMap('statistics'), 'competent'), conceptMatches)).toBe('relevance');
    // The floor applies with or without a map.
    expect(serveDrop(c, 'competent', null, conceptMatches)).toBe('relevance');
  });
});

describe('serveDrop: off-map (relevance < 85 and no map concept at the stage or either neighbour)', () => {
  it('holds a learning-strategy video in python novice and a database-internals build in sql proficient', () => {
    const python = namesNearStage(realMap('python'), 'novice');
    const sql = namesNearStage(realMap('sql'), 'proficient');
    expect(
      serveDrop(card('How I Would Learn Python FAST (if I could start over)', 'novice', 82, ['5-Level Python Learning Pyramid', 'Problem-Solving Mindset vs Syntax Memorization', 'Cloud Development with Google Colab'], 'https://www.youtube.com/watch?v=mC4nyib2sfg'), 'novice', python, conceptMatches),
    ).toBe('off_map');
    expect(
      serveDrop(card('Writing My Own Database From Scratch', 'proficient', 82, ['Naive Database Storage & Record Offsets', 'Slotted Page Architecture', 'Index-Organized Storage vs. Page Directories'], 'https://www.youtube.com/watch?v=5Pc18ge9ohI'), 'proficient', sql, conceptMatches),
    ).toBe('off_map');
  });

  it('serves the same card at relevance 85 or more, or when the topic has no map', () => {
    const c = card('Writing My Own Database From Scratch', 'proficient', 85, ['Slotted Page Architecture'], 'https://www.youtube.com/watch?v=5Pc18ge9ohI');
    expect(serveDrop(c, 'proficient', namesNearStage(realMap('sql'), 'proficient'), conceptMatches)).toBeNull();
    expect(serveDrop({ ...c, quality: { relevance: 82 } }, 'proficient', null, conceptMatches)).toBeNull();
  });
});

describe('serveDrop: page kinds come first', () => {
  it('holds a docs index even at relevance 95', () => {
    expect(serveDrop(card('Reference', 'competent', 95, ['Deployments'], 'https://kubernetes.io/docs/reference'), 'competent', namesNearStage(realMap('kubernetes'), 'competent'), conceptMatches)).toBe('page_kind');
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
    // Real titles from the kubernetes competent pool.
    const cards = [
      card('Reference', 'competent', 99, [], 'https://kubernetes.io/docs/reference'),
      card('Data Storytelling 101 | Think Like a Data Analyst', 'competent', 45),
      card('Kubernetes Simply Explained', 'novice', 80),
      card('Deployments', 'competent', 90),
      card('Service', 'competent', 90),
      card('Most Common Kubernetes Deployment Strategies (Examples & Code)', 'competent', 90),
    ];
    const out = servedCards(cards, 'competent', null, conceptMatches);
    expect(out.cards.map((c) => c.title)).toEqual(['Data Storytelling 101 | Think Like a Data Analyst', 'Kubernetes Simply Explained', 'Deployments', 'Service', 'Most Common Kubernetes Deployment Strategies (Examples & Code)']);
    expect(out).toMatchObject({ refilled: 2, flagged: true });
  });
});

describe("servedCards: the learner's format first (lead, 4 Nov 2026)", () => {
  const typed = (title: string, stage: ServableCard['stage'], relevance: number, url?: string) => card(title, stage, relevance, ['Not on the map'], url);
  // A video by its id, not a host substring (CodeQL js/incomplete-url-substring-sanitization).
  const isText = (c: ServableCard) => youtubeIdFromUrl(c.url) === null;

  it('returns only off-map holds of the learner format, best first, up to 3 usable, and flags the pool', () => {
    const names = namesNearStage(realMap('public-speaking'), 'novice');
    const cards = [
      ...[1, 2, 3, 4, 5, 6].map((n) => card(`Video ${n}`, 'novice', 95, ['Speech anxiety'], `https://www.youtube.com/watch?v=abcdefghij${n}`)),
      card('Speech and Communication - OER By Discipline - LibGuides at Hillsborough College', 'novice', 70, ['OER Collections for Communication Studies'], 'https://libguides.hcfl.edu/c.php?g=1019668&p=7386194'),
      typed('An off-map guide', 'novice', 80, 'https://example.com/guide'),
      typed('Low relevance guide', 'novice', 60, 'https://example.com/low'),
      typed('Introduction to Public Speaking', 'novice', 99, 'https://www.coursera.org/learn/public-speaking'),
    ];
    const out = servedCards(cards, 'novice', names, conceptMatches, { usable: isText });
    expect(out.cards.filter(isText).map((c) => c.title)).toEqual(['Speech and Communication - OER By Discipline - LibGuides at Hillsborough College', 'An off-map guide']);
    expect(out).toMatchObject({ formatRefilled: 2, refilled: 0, flagged: true });
  });

  it('changes nothing when the learner format already has 3 usable cards', () => {
    const cards = [1, 2, 3, 4, 5, 6].map((n) => card(`Guide ${n}`, 'novice', 90, [], `https://example.com/${n}`));
    expect(servedCards(cards, 'novice', null, conceptMatches, { usable: isText })).toMatchObject({ formatRefilled: 0, flagged: false });
  });
});

