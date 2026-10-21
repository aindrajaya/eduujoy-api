import type { Config } from 'jest';

// Integration tests against the Neon test branch (PRD-API §12), one schema per run.
const config: Config = {
  rootDir: '..',
  roots: ['<rootDir>/test'],
  testEnvironment: 'node',
  testRegex: '\\.int-spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  moduleFileExtensions: ['ts', 'js', 'json'],
  globalSetup: '<rootDir>/test/db/global-setup.ts',
  globalTeardown: '<rootDir>/test/db/global-teardown.ts',
  testTimeout: 30_000,
};

export default config;
