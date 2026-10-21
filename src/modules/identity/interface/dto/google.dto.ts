import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/** Same-site path only: starts with one "/" and is not "//host" or "/\host" (no open redirect). */
export const SAFE_RETURN_TO = /^\/(?![/\\])[^\s]*$/;

export class GoogleStartQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(512)
  @Matches(SAFE_RETURN_TO, { message: 'returnTo must be a path on this site' })
  returnTo?: string;
}

/** Google appends scope, authuser, prompt, hd and iss; they are accepted and ignored. */
export class GoogleCallbackQueryDto {
  @IsOptional() @IsString() @MaxLength(2048) code?: string;
  @IsOptional() @IsString() @MaxLength(512) state?: string;
  @IsOptional() @IsString() @MaxLength(128) error?: string;
  @IsOptional() @IsString() @MaxLength(1024) scope?: string;
  @IsOptional() @IsString() @MaxLength(16) authuser?: string;
  @IsOptional() @IsString() @MaxLength(64) prompt?: string;
  @IsOptional() @IsString() @MaxLength(255) hd?: string;
  @IsOptional() @IsString() @MaxLength(255) iss?: string;
}
