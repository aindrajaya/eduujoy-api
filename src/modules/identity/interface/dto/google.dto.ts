import { ApiHideProperty, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Allow, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

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

  @ApiPropertyOptional({
    type: Boolean,
    default: false,
    description:
      'Re-authentication for a sensitive action (DELETE /v1/me). Google is asked for a fresh\n' +
      'sign-in (prompt=login, max_age=0), and the API counts the session as freshly signed in\n' +
      "only if the ID token's auth_time is within the last 10 minutes; otherwise the sign-in\n" +
      'succeeds but DELETE /v1/me still returns REAUTH_REQUIRED.\n',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  reauth?: 'true' | 'false';
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
