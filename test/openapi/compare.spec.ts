import { compareToContract, normalizeSchema, type OpenApiDoc } from '../../scripts/openapi/compare';

const contract: OpenApiDoc = {
  security: [{ cookieAuth: [] }],
  components: {
    schemas: {
      Plan: { type: 'string', enum: ['free', 'subscription'] },
      Me: {
        type: 'object',
        required: ['plan', 'name'],
        properties: { plan: { $ref: '#/components/schemas/Plan' }, name: { type: ['string', 'null'] } },
      },
      Problem: { type: 'object', required: ['code'], properties: { code: { type: 'string' } } },
    },
    parameters: {
      XRequestedWith: { name: 'X-Requested-With', in: 'header', required: true, schema: { type: 'string', const: 'eduujoy' } },
    },
    responses: {
      Unauthorized: { description: 'x', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
    },
  },
  paths: {
    '/me': {
      get: {
        operationId: 'authMe',
        responses: {
          '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Me' } } } },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/logout': {
      post: {
        operationId: 'authLogout',
        security: [],
        parameters: [{ $ref: '#/components/parameters/XRequestedWith' }],
        responses: { '204': { description: 'ok' } },
      },
    },
    '/paths': {
      get: {
        operationId: 'pathsList',
        parameters: [{ name: 'status', in: 'query', required: false, schema: { type: 'string' } }],
        responses: { '200': { description: 'ok' } },
      },
    },
  },
};

// What @nestjs/swagger emits for the same API: no global security, 3.0-style nullable,
// allOf-wrapped enum refs, one-value enum for const, its own schema names.
const api = (): OpenApiDoc => ({
  components: {
    schemas: {
      PlanEnum: { type: 'string', enum: ['subscription', 'free'] },
      MeDto: {
        type: 'object',
        required: ['name', 'plan'],
        properties: { name: { type: 'string', nullable: true }, plan: { allOf: [{ $ref: '#/components/schemas/PlanEnum' }] } },
      },
      Problem: { type: 'object', required: ['code'], properties: { code: { type: 'string', description: 'machine code' } } },
    },
  },
  paths: {
    '/me': {
      get: {
        operationId: 'authMe',
        security: [{ cookieAuth: [] }],
        responses: {
          '200': { description: 'Current user', content: { 'application/json': { schema: { $ref: '#/components/schemas/MeDto' } } } },
          '401': { description: 'nope', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
        },
      },
    },
    '/logout': {
      post: {
        operationId: 'authLogout',
        parameters: [{ name: 'X-Requested-With', in: 'header', required: true, schema: { type: 'string', enum: ['eduujoy'] } }],
        responses: { '204': { description: 'Signed out' } },
      },
    },
  },
});

describe('normalizeSchema', () => {
  it('treats 3.0 nullable and 3.1 type arrays alike', () => {
    expect(normalizeSchema({}, { type: 'string', nullable: true })).toEqual(normalizeSchema({}, { type: ['null', 'string'] }));
  });

  it('treats const and a one-value enum alike, and null-in-enum as a null type', () => {
    expect(normalizeSchema({}, { const: 'a' })).toEqual(normalizeSchema({}, { enum: ['a'] }));
    expect(normalizeSchema({}, { type: ['string', 'null'], enum: ['ok', null] })).toEqual({ enum: ['ok'], type: ['null', 'string'] });
  });

  it('ignores documentation-only keys', () => {
    expect(normalizeSchema({}, { type: 'string', description: 'x', example: 'y' })).toEqual({ type: ['string'] });
  });
});

describe('compareToContract', () => {
  it('accepts an equivalent API and lists contract operations that are not built yet', () => {
    const result = compareToContract(api(), contract);

    expect(result.errors).toEqual([]);
    expect(result.notImplemented).toEqual(['GET /paths']);
  });

  it('flags an exported operation missing from the contract', () => {
    const doc = api();
    doc.paths = { ...doc.paths, '/extra': { get: { operationId: 'extra', responses: { '200': { description: 'x' } } } } };

    expect(compareToContract(doc, contract).errors).toEqual(['GET /extra: not in the contract']);
  });

  it('flags changed response codes, schema fields and security', () => {
    const doc = api();
    const me = doc.paths?.['/me']?.get as Record<string, unknown>;
    me.security = [];
    (me.responses as Record<string, unknown>)['403'] = { description: 'x' };
    const meSchema = doc.components?.schemas?.MeDto as { required: string[] };
    meSchema.required = ['plan'];

    const errors = compareToContract(doc, contract).errors.join('\n');

    expect(errors).toContain('GET /me security');
    expect(errors).toContain('GET /me response codes');
    expect(errors).toContain('GET /me response 200 /application/json/required');
  });

  it('flags a missing required header and applies only explicit exceptions', () => {
    const doc = api();
    (doc.paths?.['/logout']?.post as Record<string, unknown>).parameters = [];
    doc.paths = {
      ...doc.paths,
      '/paths': { get: { operationId: 'pathsList', security: [{ cookieAuth: [] }], responses: { '200': { description: 'ok' } } } },
    };

    const result = compareToContract(doc, contract, [
      { method: 'get', path: '/paths', parameter: { in: 'query', name: 'status' }, reason: 'lands in A9' },
    ]);

    expect(result.errors).toEqual([expect.stringContaining('POST /logout parameter header:X-Requested-With')]);
    expect(result.excepted).toEqual(['GET /paths parameter query:status: lands in A9']);
  });
});
