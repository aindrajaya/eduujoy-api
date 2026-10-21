import { Body, Controller, Get, HttpCode, Post, Req, Res, SerializeOptions, UseInterceptors } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { type Request, type Response } from 'express';
import {
  ACCESS_COOKIE,
  accessCookieOptions,
  AccessTokenService,
  type AuthUser,
  CurrentUser,
  Public,
  REFRESH_COOKIE,
  refreshCookieOptions,
} from '../../../shared/common/auth';
import { SessionInvalidError } from '../application/errors';
import { GetMe, type MeView } from '../application/get-me.query';
import { LoginWithPassword } from '../application/login.usecase';
import { Logout } from '../application/logout.usecase';
import { RefreshSession } from '../application/refresh.usecase';
import { RegisterUser } from '../application/register.usecase';
import { type IssuedSession, type RequestMeta } from '../application/session-issuer';
import { LoginRequestDto, RegisterRequestDto } from './dto/auth.dto';
import { MeResponseDto } from './dto/me.response';
import { IdentityErrorsInterceptor, toIdentityProblem } from './identity-errors.interceptor';

/** PRD-API §6: 5 attempts per minute per IP on credential endpoints. */
const CREDENTIAL_THROTTLE = { default: { limit: 5, ttl: 60_000 } };

export function requestMeta(req: Request): RequestMeta {
  return { userAgent: req.get('user-agent') ?? null, ip: req.ip ?? null };
}

export function setSessionCookies(res: Response, session: IssuedSession): void {
  res.cookie(ACCESS_COOKIE, session.accessToken, accessCookieOptions);
  res.cookie(REFRESH_COOKIE, session.refreshToken, refreshCookieOptions);
}

export function clearSessionCookies(res: Response): void {
  // clearCookie must repeat path and flags (but not maxAge) for the browser to match the cookie.
  res.clearCookie(ACCESS_COOKIE, { ...accessCookieOptions, maxAge: undefined });
  res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOptions, maxAge: undefined });
}

function readCookie(req: Request, name: string): string | undefined {
  const value = (req.cookies as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'string' ? value : undefined;
}

const refreshCookie = (req: Request): string | undefined => readCookie(req, REFRESH_COOKIE);

@Controller('v1/auth')
@UseInterceptors(IdentityErrorsInterceptor)
export class AuthController {
  constructor(
    private readonly registerUser: RegisterUser,
    private readonly login: LoginWithPassword,
    private readonly refresh: RefreshSession,
    private readonly logoutUser: Logout,
    private readonly getMe: GetMe,
    private readonly accessTokens: AccessTokenService,
  ) {}

  @Public()
  @Throttle(CREDENTIAL_THROTTLE)
  @Post('register')
  @HttpCode(201)
  @SerializeOptions({ type: MeResponseDto })
  async register(
    @Body() body: RegisterRequestDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MeView> {
    const session = await this.registerUser.execute(body, requestMeta(req));
    setSessionCookies(res, session);
    return this.getMe.execute(session.user.id);
  }

  @Public()
  @Throttle(CREDENTIAL_THROTTLE)
  @Post('login')
  @HttpCode(200)
  @SerializeOptions({ type: MeResponseDto })
  async signIn(
    @Body() body: LoginRequestDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MeView> {
    const session = await this.login.execute(body, requestMeta(req));
    setSessionCookies(res, session);
    return this.getMe.execute(session.user.id);
  }

  @Public()
  @Post('refresh')
  @HttpCode(204)
  async rotate(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    try {
      setSessionCookies(res, await this.refresh.execute(refreshCookie(req), requestMeta(req)));
    } catch (error) {
      // A concurrent refresh lost to another tab: leave its fresh cookies alone (no Set-Cookie).
      // Any other failure means a dead token, so clear both and let the UI go to sign-in.
      if (!(error instanceof SessionInvalidError && error.reason === 'concurrent')) clearSessionCookies(res);
      throw toIdentityProblem(error);
    }
  }

  /**
   * Public so an expired access token can't block sign-out (CsrfGuard still applies). Revokes what
   * the cookies identify and always clears both, even when nothing matched.
   */
  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    try {
      const accessToken = readCookie(req, ACCESS_COOKIE);
      const claims = accessToken ? await this.accessTokens.verify(accessToken) : null;
      await this.logoutUser.execute({ sessionId: claims?.sessionId, refreshToken: refreshCookie(req) });
    } finally {
      clearSessionCookies(res);
    }
  }

  @Get('me')
  @SerializeOptions({ type: MeResponseDto })
  me(@CurrentUser() user: AuthUser): Promise<MeView> {
    return this.getMe.execute(user.userId);
  }
}
