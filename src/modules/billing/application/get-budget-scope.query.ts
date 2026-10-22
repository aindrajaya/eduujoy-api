import { Injectable } from '@nestjs/common';
import { nextPathScope } from '../domain/quota';
import { GetQuotaQuery } from './get-quota.query';

/**
 * Public billing query (D1): the AI budget scope of a learner's next path, for work that starts before
 * the path is charged (discovery on PlacementComputed). Pathing uses the real ReservePath charge.
 */
@Injectable()
export class GetBudgetScopeQuery {
  constructor(private readonly quota: GetQuotaQuery) {}

  async execute(userId: string): Promise<'free' | 'paid'> {
    return nextPathScope(await this.quota.execute(userId));
  }
}
