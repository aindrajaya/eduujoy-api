import { Expose, Type } from 'class-transformer';

/** Contract schema Me (GET /v1/auth/me, and the body of register and login). */
export class MeUserDto {
  @Expose() id!: string;
  @Expose() email!: string;
  @Expose() name!: string | null;
  @Expose() locale!: string;
  @Expose() weeklyHoursDefault!: number | null;
}

export class QuotaDto {
  @Expose() monthlyPaths!: number;
  @Expose() usedPaths!: number;
  @Expose() credits!: number;
  @Expose() periodEnd!: Date;
}

export class MeResponseDto {
  @Expose() @Type(() => MeUserDto) user!: MeUserDto;
  @Expose() roles!: ('learner' | 'reviewer' | 'admin')[];
  @Expose() plan!: 'free' | 'subscription';
  @Expose() @Type(() => QuotaDto) quota!: QuotaDto;
}
