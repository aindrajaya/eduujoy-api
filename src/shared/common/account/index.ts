export { type AccountDataContributor } from './account-data';

/** Each module provides its contributor under its own token; the account module composes them. */
export const ACCOUNT_DATA = {
  identity: Symbol('IdentityAccountData'),
  assessment: Symbol('AssessmentAccountData'),
  progress: Symbol('ProgressAccountData'),
  billing: Symbol('BillingAccountData'),
  catalog: Symbol('CatalogAccountData'),
} as const;
