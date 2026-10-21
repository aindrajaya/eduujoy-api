import { createTestApp, type TestApp } from './app';
import { routesMissingResponseDto } from './route-serialization';

describe('response serialization coverage (e2e)', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('every controller route that returns a body declares @SerializeOptions({ type })', () => {
    expect(routesMissingResponseDto(app)).toEqual([]);
  });
});
