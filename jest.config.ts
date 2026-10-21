import type { Config } from 'jest';

const config: Config = {
  rootDir: '.',
  roots: ['<rootDir>/src'],
  testEnvironment: 'node',
  testRegex: '\\.spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/main.ts'],
  coverageDirectory: 'coverage',
};

export default config;
