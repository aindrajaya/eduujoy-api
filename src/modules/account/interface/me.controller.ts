import { Controller, Delete, Get, HttpCode, Res, UseInterceptors } from '@nestjs/common';
import { ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { type Response } from 'express';
import { type AuthUser, clearSessionCookies, CurrentUser } from '../../../shared/common/auth';
import { ApiAccessCookieAuth, ApiCsrfHeader, ApiProblem, schemaRef } from '../../../shared/common/openapi';
import { DeleteAccount } from '../application/delete-account.usecase';
import { ExportAccount } from '../application/export-account.usecase';
import { AccountErrorsInterceptor } from './account-errors.interceptor';

/** An export reads every module's rows; a few per hour is plenty for a person and bounds the cost. */
const EXPORT_THROTTLE = { default: { limit: 5, ttl: 60 * 60 * 1000 } };
const DELETE_THROTTLE = { default: { limit: 5, ttl: 60 * 1000 } };

@ApiTags('auth')
@ApiAccessCookieAuth()
@Controller('v1/me')
@UseInterceptors(AccountErrorsInterceptor)
export class MeController {
  constructor(
    private readonly exporter: ExportAccount,
    private readonly deleter: DeleteAccount,
  ) {}

  @Get('export')
  @Throttle(EXPORT_THROTTLE)
  @ApiOperation({
    operationId: 'meExport',
    summary: 'Download all my personal data as JSON (GDPR-level export, master PRD §12; PRD-API §12).',
    description: 'No re-authentication needed; rate-limited.',
  })
  @ApiOkResponse({
    description: 'The export, sent as an attachment (`Content-Disposition`).',
    headers: { 'Content-Disposition': { description: 'Attachment file name. Exposed to allow-listed origins via CORS.', schema: { type: 'string' } } },
    content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
  })
  @ApiProblem(401)
  @ApiProblem(429)
  async export(@CurrentUser() user: AuthUser, @Res() res: Response): Promise<void> {
    const data = await this.exporter.execute(user.userId);
    const day = new Date().toISOString().slice(0, 10);
    res
      .status(200)
      .set('Content-Disposition', `attachment; filename="eduujoy-export-${day}.json"`)
      // Personal data: never kept by the browser or a shared cache.
      .set('Cache-Control', 'no-store')
      .json(data);
  }

  @Delete()
  @HttpCode(204)
  @Throttle(DELETE_THROTTLE)
  @ApiOperation({
    operationId: 'meDelete',
    summary: 'Delete my account and personal data; signs out (clears both cookies).',
    description:
      'Requires a sign-in (password or Google, not a token refresh) within the last 10 minutes.\n' +
      'Otherwise 401 with code `REAUTH_REQUIRED`: the client must not try a refresh for it (a\n' +
      'refresh keeps the original sign-in time); it asks the learner to sign in again, then retries.\n',
  })
  @ApiCsrfHeader()
  @ApiNoContentResponse({ description: 'Deleted and signed out; both cookies cleared.' })
  @ApiResponse({
    status: 401,
    description: 'Not signed in (`UNAUTHENTICATED`), or the sign-in is older than 10 minutes (`REAUTH_REQUIRED`).',
    content: { 'application/problem+json': { schema: schemaRef('Problem') } },
  })
  @ApiProblem(403)
  async delete(@CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.deleter.execute(user.userId, user.sessionId);
    clearSessionCookies(res);
  }
}
