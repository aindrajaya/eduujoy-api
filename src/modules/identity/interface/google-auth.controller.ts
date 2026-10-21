import { Controller, Get, Logger, Query, Req, Res } from '@nestjs/common';
import { ApiFoundResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { type CookieOptions, type Request, type Response } from 'express';
import { Public } from '../../../shared/common/auth';
import { SESSION_COOKIES_HEADER } from '../../../shared/common/openapi';
import { AppConfig } from '../../../shared/config';
import { CompleteGoogleSignIn, OAuthFailedError, StartGoogleSignIn } from '../application/google-sign-in.usecase';
import { OAUTH_STATE_TTL_SECONDS } from '../application/ports/google';
import { safeReturnTo } from '../domain/return-to';
import { clearSessionCookies, requestMeta, setSessionCookies } from './auth.controller';
import { GoogleCallbackQueryDto, GoogleStartQueryDto } from './dto/google.dto';

export const OAUTH_COOKIE = 'ej_oauth';
// Lax so the cookie rides Google's top-level redirect back to the callback; scoped to the flow's paths.
const oauthCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/v1/auth/google',
  maxAge: OAUTH_STATE_TTL_SECONDS * 1000,
};

@ApiTags('auth')
@Public()
@Controller('v1/auth/google')
export class GoogleAuthController {
  private readonly logger = new Logger(GoogleAuthController.name);
  private readonly origins: string[];

  constructor(
    private readonly startSignIn: StartGoogleSignIn,
    private readonly completeSignIn: CompleteGoogleSignIn,
    config: AppConfig,
  ) {
    this.origins = config.env.APP_ORIGIN;
  }

  @Get()
  @ApiOperation({ operationId: 'authGoogleStart', summary: 'Start Google OAuth (authorization code with PKCE).' })
  @ApiFoundResponse({
    description: 'Redirect to Google.',
    headers: { Location: { schema: { type: 'string', format: 'uri' } } },
  })
  async start(@Query() query: GoogleStartQueryDto, @Req() req: Request, @Res() res: Response): Promise<void> {
    const { redirectUrl, sealedState } = await this.startSignIn.execute({
      origin: this.originFromReferer(req.get('referer')),
      returnTo: safeReturnTo(query.returnTo),
    });
    res.cookie(OAUTH_COOKIE, sealedState, oauthCookieOptions);
    res.redirect(302, redirectUrl);
  }

  @Get('callback')
  @ApiOperation({ operationId: 'authGoogleCallback', summary: 'OAuth callback; sets cookies and redirects to APP_ORIGIN.' })
  @ApiFoundResponse({
    description: 'Redirect back to APP_ORIGIN (with `?error=<code>` on failure).',
    headers: { Location: { schema: { type: 'string', format: 'uri' } }, ...SESSION_COOKIES_HEADER },
  })
  async callback(@Query() query: GoogleCallbackQueryDto, @Req() req: Request, @Res() res: Response): Promise<void> {
    const sealed = (req.cookies as Record<string, unknown> | undefined)?.[OAUTH_COOKIE];
    res.clearCookie(OAUTH_COOKIE, { ...oauthCookieOptions, maxAge: undefined });
    try {
      const { session, redirectTo } = await this.completeSignIn.execute(
        {
          code: query.code,
          state: query.state,
          error: query.error,
          sealedState: typeof sealed === 'string' ? sealed : undefined,
        },
        requestMeta(req),
      );
      setSessionCookies(res, session);
      res.redirect(302, redirectTo);
    } catch (error) {
      const failure = error instanceof OAuthFailedError ? error : new OAuthFailedError('oauth_failed', null);
      if (!(error instanceof OAuthFailedError)) {
        this.logger.error({ err: error instanceof Error ? error : new Error(String(error)) }, 'Google sign-in failed');
      }
      clearSessionCookies(res);
      const origin = failure.origin !== null && this.origins.includes(failure.origin) ? failure.origin : this.origins[0];
      res.redirect(302, `${origin ?? ''}/?error=${failure.code}`);
    }
  }

  /** The SPA origin the flow started from, if allow-listed; else the primary APP_ORIGIN. */
  private originFromReferer(referer: string | undefined): string {
    const fallback = this.origins[0] ?? '';
    if (!referer) return fallback;
    try {
      const origin = new URL(referer).origin;
      return this.origins.includes(origin) ? origin : fallback;
    } catch {
      return fallback;
    }
  }
}
