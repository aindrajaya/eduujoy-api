import { type SchemaObject } from './types';
import { PROBLEM_CODES } from '../problem/problem';

const ref = (name: string): { $ref: string } => ({ $ref: `#/components/schemas/${name}` });

/** RFC 9457 problem schemas, written from the API's own error model (problem.ts). */
export const PROBLEM_SCHEMAS: Record<string, SchemaObject> = {
  ProblemCode: { type: 'string', enum: [...PROBLEM_CODES] },
  FieldError: {
    type: 'object',
    required: ['field', 'message'],
    properties: {
      field: { type: 'string', description: 'Dot path, e.g. answers.3.value' },
      message: { type: 'string' },
    },
  },
  Problem: {
    type: 'object',
    required: ['type', 'title', 'status', 'code', 'requestId'],
    properties: {
      type: { type: 'string', format: 'uri' },
      title: { type: 'string' },
      status: { type: 'integer' },
      detail: { type: 'string' },
      instance: { type: 'string' },
      code: ref('ProblemCode'),
      requestId: { type: 'string' },
      errors: { type: 'array', items: ref('FieldError') },
    },
  },
  ValidationProblem: {
    allOf: [
      ref('Problem'),
      {
        type: 'object',
        required: ['errors'],
        properties: { code: { enum: ['VALIDATION_FAILED'] }, status: { enum: [400] } },
      },
    ],
  },
};

export const schemaRef = ref;
