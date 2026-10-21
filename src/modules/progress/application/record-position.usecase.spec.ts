import { type NewPosition, type PositionRepository } from './ports/position.repository';
import { RecordPosition } from './record-position.usecase';

describe('RecordPosition', () => {
  it('appends the position as given', async () => {
    const appended: NewPosition[] = [];
    const repo: PositionRepository = {
      append: (p) => {
        appended.push(p);
        return Promise.resolve();
      },
    };
    const position: NewPosition = { userId: 'u', topicId: 't', stage: 'competent', bloom: 'C4', confidence: 0.9, source: 'diagnostic' };

    await new RecordPosition(repo).execute(position);

    expect(appended).toEqual([position]);
  });
});
