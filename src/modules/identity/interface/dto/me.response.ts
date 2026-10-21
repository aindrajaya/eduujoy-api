import { ApiProperty, ApiSchema } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { ROLES } from '../../domain/role';

/** Contract schema Me (GET /v1/auth/me, and the body of register and login). */
@ApiSchema({ name: 'MeUser' })
export class MeUserDto {
  @ApiProperty({ type: String }) @Expose() id!: string;
  @ApiProperty({ type: String, format: 'email' }) @Expose() email!: string;
  @ApiProperty({ type: String, nullable: true, required: false }) @Expose() name!: string | null;
  @ApiProperty({ type: String, default: 'en', required: false }) @Expose() locale!: string;
  @ApiProperty({ type: Number, nullable: true, required: false }) @Expose() weeklyHoursDefault!: number | null;
}

@ApiSchema({ name: 'Quota' })
export class QuotaDto {
  @ApiProperty({ type: 'integer', minimum: 0 }) @Expose() monthlyPaths!: number;
  @ApiProperty({ type: 'integer', minimum: 0 }) @Expose() usedPaths!: number;
  @ApiProperty({ type: 'integer', minimum: 0 }) @Expose() credits!: number;
  @ApiProperty({ type: String, format: 'date-time' }) @Expose() periodEnd!: Date;
}

@ApiSchema({ name: 'Me' })
export class MeResponseDto {
  @ApiProperty({ type: MeUserDto }) @Expose() @Type(() => MeUserDto) user!: MeUserDto;
  @ApiProperty({ enum: ROLES, enumName: 'Role', isArray: true }) @Expose() roles!: (typeof ROLES)[number][];
  @ApiProperty({ enum: ['free', 'subscription'], enumName: 'Plan' }) @Expose() plan!: 'free' | 'subscription';
  @ApiProperty({ type: QuotaDto }) @Expose() @Type(() => QuotaDto) quota!: QuotaDto;
}
