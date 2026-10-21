// Every table, grouped by owning module (PRD-API §4). Modules import only their own folder;
// the ESLint boundaries rule enforces that. This barrel is for drizzle-kit and the DB client.
export * from './common';
export * from './identity';
export * from './catalog';
export * from './assessment';
export * from './discovery';
export * from './pathing';
export * from './progress';
export * from './billing';
export * from './admin';
export * from './jobs';
export * from './ai';
