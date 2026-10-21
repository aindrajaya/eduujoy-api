import { type Entitlement } from '../../domain/quota';

export const QUOTA_REPOSITORY = Symbol('QuotaRepository');

export interface QuotaRepository {
  findEntitlement(userId: string): Promise<Entitlement | null>;
  creditBalance(userId: string): Promise<number>;
  countPlanCoveredPaths(userId: string, from: Date, to: Date): Promise<number>;
}
