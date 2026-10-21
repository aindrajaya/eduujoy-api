import { ApiHideProperty, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Allow, IsOptional, IsString, MaxLength } from 'class-validator';

export class GoogleStartQueryDto {
  /** Never rejected: anything that isn't a safe same-site path falls back (see safeReturnTo). */
  @ApiPropertyOptional({
    type: String,
    maxLength: 512,
    pattern: '^/',
    description: 'Path on APP_ORIGIN to land on after sign-in. Unsafe or missing values fall back to /today.',
  })
  @Allow()
  returnTo?: unknown;
}

/** Google appends scope, authuser, prompt, hd and iss; they are accepted and ignored. */
export class GoogleCallbackQueryDto {
  @ApiProperty({ type: String }) @IsOptional() @IsString() @MaxLength(2048) code?: string;
  @ApiProperty({ type: String }) @IsOptional() @IsString() @MaxLength(512) state?: string;
  @ApiHideProperty() @IsOptional() @IsString() @MaxLength(128) error?: string;
  @ApiHideProperty() @IsOptional() @IsString() @MaxLength(1024) scope?: string;
  @ApiHideProperty() @IsOptional() @IsString() @MaxLength(16) authuser?: string;
  @ApiHideProperty() @IsOptional() @IsString() @MaxLength(64) prompt?: string;
  @ApiHideProperty() @IsOptional() @IsString() @MaxLength(255) hd?: string;
  @ApiHideProperty() @IsOptional() @IsString() @MaxLength(255) iss?: string;
}
