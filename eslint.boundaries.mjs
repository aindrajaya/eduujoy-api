// @ts-check
// Module and layer boundaries from PRD-API §4: dependencies point inward, and modules
// talk to each other only through application services or domain events.
import boundaries from 'eslint-plugin-boundaries';

const LAYERS = ['domain', 'application', 'infrastructure', 'interface'];
const sameModule = { module: '{{from.element.captured.module}}' };
const otherModule = { module: '!{{from.element.captured.module}}' };

/** @param {string[]} types */
const layers = (types, captured = sameModule) => types.map((type) => ({ element: { type, captured } }));

export default [
  {
    files: ['src/**/*.ts'],
    plugins: { boundaries },
    settings: {
      'import/resolver': { typescript: { alwaysTryTypes: true, project: './tsconfig.json' } },
      'boundaries/elements': [
        ...LAYERS.map((type) => ({
          type,
          partialMatch: false,
          pattern: `src/modules/*/${type}/**`,
          capture: ['module'],
        })),
        { type: 'module-root', partialMatch: false, pattern: 'src/modules/*', capture: ['module'] },
        { type: 'shared', partialMatch: false, pattern: 'src/shared/**' },
        { type: 'app', partialMatch: false, pattern: 'src' },
      ],
    },
    rules: {
      'boundaries/no-unknown-files': 'error',
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          message: '{{from.element.type}} must not depend on {{to.element.type}} (PRD-API §4)',
          policies: [
            { allow: { dependency: { relationship: { to: 'internal' } } } },
            { from: { element: { type: 'domain' } }, allow: { to: layers(['domain']) } },
            {
              from: { element: { type: 'application' } },
              allow: { to: [...layers(['domain', 'application']), { element: { type: 'shared' } }] },
            },
            {
              from: { element: { type: 'infrastructure' } },
              allow: {
                to: [...layers(['domain', 'application', 'infrastructure']), { element: { type: 'shared' } }],
              },
            },
            {
              from: { element: { type: 'interface' } },
              allow: {
                to: [...layers(['domain', 'application', 'interface']), { element: { type: 'shared' } }],
              },
            },
            // Cross-module: only another module's application services and domain events.
            {
              from: { element: { types: { anyOf: ['application', 'infrastructure', 'interface'] } } },
              allow: { to: layers(['application'], otherModule) },
            },
            {
              from: { element: { types: { anyOf: ['application', 'infrastructure'] } } },
              allow: { to: layers(['domain'], otherModule) },
            },
            {
              from: { element: { type: 'module-root' } },
              allow: { to: [...layers([...LAYERS]), { element: { type: 'shared' } }] },
            },
            { from: { element: { type: 'shared' } }, allow: { to: { element: { type: 'shared' } } } },
            {
              from: { element: { type: 'app' } },
              allow: {
                to: [{ element: { types: { anyOf: ['shared', 'module-root', 'app'] } } }],
              },
            },
          ],
        },
      ],
    },
  },
  // The domain layer is framework-free: relative imports only, so no Nest, ORM or vendor packages.
  {
    files: ['src/modules/*/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^[^.]',
              message: 'domain/ must be pure TypeScript (PRD-API §4); move framework or vendor code outward.',
            },
          ],
        },
      ],
    },
  },
];
