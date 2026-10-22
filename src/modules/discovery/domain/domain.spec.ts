import {
  badConceptRange,
  embeddingText,
  isBlocked,
  isRecognisedPaper,
  judgeCard,
  nextLiveness,
  normaliseUrl,
  pacificDay,
  poolPlan,
  poolStatus,
  qualityScore,
  timestampSeconds,
  youtubeIdFromUrl,
} from '.';

const quality = (v: number) => ({ relevance: v, accuracySignals: v, recency: v, teaching: v });

describe('card rules', () => {
  it('scores quality as the mean of the four sub-scores', () => {
    expect(qualityScore({ relevance: 92, accuracySignals: 85, recency: 80, teaching: 88 })).toBe(86.3);
  });

  it('drops under 60, sends low confidence to review, serves the rest', () => {
    expect(judgeCard({ quality: quality(59), confidence: 0.9, concepts: [], durationMin: null, isVideo: false })).toMatchObject({ status: 'dropped' });
    expect(judgeCard({ quality: quality(60), confidence: 0.69, concepts: [], durationMin: null, isVideo: false })).toMatchObject({ status: 'review' });
    expect(judgeCard({ quality: quality(60), confidence: 0.7, concepts: [], durationMin: null, isVideo: false })).toEqual({ status: 'served', reason: null });
  });

  it('sends a video whose concept range runs past its duration to review', () => {
    const concepts = [{ name: 'cleanup', start: '04:10', end: '07:45' }, { name: 'late', start: '17:00', end: '19:30' }];
    expect(badConceptRange(concepts, 18)).toBe('late');
    expect(badConceptRange(concepts, 20)).toBeNull();
    expect(badConceptRange([{ name: 'backwards', start: '05:00', end: '04:00' }], 20)).toBe('backwards');
    expect(badConceptRange([{ name: 'garbage', start: 'soon', end: '04:00' }], 20)).toBe('garbage');
    expect(judgeCard({ quality: quality(80), confidence: 0.9, concepts, durationMin: 18, isVideo: true })).toEqual({ status: 'review', reason: 'timestamp out of range: late' });
  });

  it('parses timestamps', () => {
    expect(timestampSeconds('04:10')).toBe(250);
    expect(timestampSeconds('1:02:03')).toBe(3723);
    expect(timestampSeconds('4:75')).toBeNull();
  });

  it('embeds title, takeaways and concept names only', () => {
    expect(embeddingText({ title: 'T', keyTakeaways: ['a', 'b'], concepts: [{ name: 'c', start: '0:01', end: '0:02' }] })).toBe('T\na\nb\nc');
  });
});

describe('source rules', () => {
  it('keeps https URLs without tracking parameters, fragments or credentials', () => {
    expect(normaliseUrl('https://React.dev/learn/?utm_source=x&tab=1#intro')).toBe('https://react.dev/learn/?tab=1');
    expect(normaliseUrl('https://react.dev/learn/')).toBe('https://react.dev/learn');
    expect(normaliseUrl('http://react.dev/learn')).toBeNull();
    expect(normaliseUrl('https://user:pw@react.dev/')).toBeNull();
    expect(normaliseUrl('https://react.dev:8443/')).toBeNull();
    expect(normaliseUrl('not a url')).toBeNull();
  });

  it('blocks content farms and their subdomains', () => {
    expect(isBlocked('https://www.pinterest.com/pin/1')).toBe(true);
    expect(isBlocked('https://uk.pinterest.com/pin/1')).toBe(true);
    expect(isBlocked('https://notpinterest.com/')).toBe(false);
  });

  it('reads YouTube ids from watch, short and youtu.be links only', () => {
    expect(youtubeIdFromUrl('https://www.youtube.com/watch?v=abc123DEF45&t=4')).toBe('abc123DEF45');
    expect(youtubeIdFromUrl('https://youtu.be/abc123DEF45')).toBe('abc123DEF45');
    expect(youtubeIdFromUrl('https://youtube.com/shorts/abc123DEF45')).toBe('abc123DEF45');
    expect(youtubeIdFromUrl('https://www.youtube.com/channel/abc')).toBeNull();
    expect(youtubeIdFromUrl('https://evil.example/watch?v=abc123DEF45')).toBeNull();
  });

  it('accepts papers with a DOI or an arXiv id only', () => {
    expect(isRecognisedPaper({ doi: '10.1145/1', arxivId: null })).toBe(true);
    expect(isRecognisedPaper({ doi: null, arxivId: null })).toBe(false);
  });
});

describe('pool plan and status', () => {
  it('makes two video searches per discovery and adds papers from competent up', () => {
    expect(poolPlan('React', 'novice')).toMatchObject({ videoSearches: ['React for beginners', 'React explained'], paperQuery: null, maxVideoMin: 20 });
    expect(poolPlan('React', 'competent').paperQuery).toBe('React');
  });

  it('is ready with three or more served types', () => {
    expect(poolStatus(['youtube', 'youtube', 'article'])).toBe('thin');
    expect(poolStatus(['youtube', 'article', 'paper'])).toBe('ready');
  });
});

describe('liveness and quota day', () => {
  it('marks a link dead after two failures in a row; a success resets the count', () => {
    expect(nextLiveness(0, false)).toEqual({ failedChecks: 1, dead: false });
    expect(nextLiveness(1, false)).toEqual({ failedChecks: 2, dead: true });
    expect(nextLiveness(1, true)).toEqual({ failedChecks: 0, dead: false });
  });

  it('counts the YouTube quota day in Pacific time', () => {
    expect(pacificDay(new Date('2026-10-22T06:59:00Z'))).toBe('2026-10-21');
    expect(pacificDay(new Date('2026-10-22T07:00:00Z'))).toBe('2026-10-22');
  });
});
