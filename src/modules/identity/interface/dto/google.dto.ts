import { Allow, IsOptional, IsString, MaxLength } from 'class-validator';

export class GoogleStartQueryDto {
  /** Never rejected: anything that isn't a safe same-site path falls back (see safeReturnTo). */
  @Allow()
  returnTo?: unknown;
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
