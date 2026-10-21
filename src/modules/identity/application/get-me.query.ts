import { Inject, Injectable } from '@nestjs/common';
import { GetQuotaQuery } from '../../billing/application/get-quota.query';
import { type Role } from '../domain/role';
import { UserNotFoundError } from './errors';
import { USER_REPOSITORY, type UserRepository } from './ports/user.repository';

export interface MeView {
  user: { id: string; email: string; name: string | null; locale: string; weeklyHoursDefault: number | null };
  roles: Role[];
  plan: 'free' | 'subscription';
  quota: { monthlyPaths: number; usedPaths: number; credits: number; periodEnd: Date };
}

@Injectable()
export class GetMe {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    private readonly quota: GetQuotaQuery,
  ) {}

  async execute(userId: string): Promise<MeView> {
    const user = await this.users.findById(userId);
    if (!user) throw new UserNotFoundError();
    const { plan, monthlyPaths, usedPaths, credits, periodEnd } = await this.quota.execute(user.id);
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        locale: user.locale,
        weeklyHoursDefault: user.weeklyHoursDefault,
      },
      roles: user.roles,
      plan,
      quota: { monthlyPaths, usedPaths, credits, periodEnd },
    };
  }
}
