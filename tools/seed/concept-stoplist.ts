// Generic concept names that describe the material, not the topic. META_CONCEPTS mirrors, entry for entry,
// the coreConcepts stop-list in src/modules/pathing/application/select-cards.ts on slice/A9-pathing (the API
// lane's; lead, 2 Nov 2026: keep the two the same). Once A9 merges and exports it, import it from there
// instead of keeping this copy.
export const META_CONCEPTS = [
  'installation',
  'install',
  'setup',
  'set up',
  'getting started',
  'api reference',
  'reference',
  'documentation',
  'docs',
  'course overview',
  'overview',
  'introduction',
  'intro',
  'interview prep',
  'interview preparation',
  'interview questions',
  'faq',
  'resources',
  'conclusion',
  'summary',
];

/** Vague names that aren't on the shared list: they send a map to review instead of failing it. */
export const VAGUE_CONCEPTS = ['basics', 'fundamentals', 'advanced topics', 'miscellaneous', 'other topics', 'best practices', 'core concepts'];

export function normaliseConcept(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9+#]+/g, ' ')
    .trim();
}
