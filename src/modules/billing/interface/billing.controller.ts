import { Body, Controller, Headers, HttpCode, Post, type RawBodyRequest, Req, Res, SerializeOptions, UseInterceptors } from '@nestjs/common';
import { ApiBody, ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { type Request, type Response } from 'express';
import { type AuthUser, CurrentUser, Public, SkipCsrf } from '../../../shared/common/auth';
import { ApiAccessCookieAuth, ApiCsrfHeader, ApiProblem, ApiServiceUnavailable } from '../../../shared/common/openapi';
import { CreateCheckout } from '../application/create-checkout.usecase';
import { ReceiveWebhook } from '../application/receive-webhook.usecase';
import { BillingErrorsInterceptor } from './billing-errors.interceptor';
import { CheckoutRequestDto, CheckoutResponseDto } from './dto/checkout.dto';

@ApiTags('billing')
@Controller('v1/billing')
@UseInterceptors(BillingErrorsInterceptor)
export class BillingController {
  constructor(
    private readonly checkouts: CreateCheckout,
    private readonly webhooks: ReceiveWebhook,
  ) {}

  @Post('checkout')
  @HttpCode(200)
  @ApiAccessCookieAuth()
  @SerializeOptions({ type: CheckoutResponseDto })
  @ApiOperation({
    operationId: 'billingCheckout',
    summary: 'Create a Lemon Squeezy checkout link (FR-23).',
    description:
      'After payment, Lemon Squeezy sends the learner back to `{origin}/account?checkout=success`,\n' +
      "where `{origin}` is the request's allow-listed Origin. The flag is only a hint: the plan\n" +
      'changes when the webhook is processed (`entitlement.changed`, or `GET /v1/auth/me`).\n' +
      'A `subscription` checkout while a subscription is active returns 409 `CONFLICT`; credit\n' +
      'packs are unaffected. 503 when the payment provider is unavailable.\n',
  })
  @ApiCsrfHeader()
  @ApiOkResponse({ description: 'Checkout URL.', type: CheckoutResponseDto })
  @ApiProblem(400)
  @ApiProblem(401)
  @ApiProblem(409)
  @ApiServiceUnavailable()
  checkout(@CurrentUser() user: AuthUser, @Body() body: CheckoutRequestDto, @Headers('origin') origin: string | undefined): Promise<{ url: string }> {
    return this.checkouts.execute(user.userId, body.product, origin);
  }

  /** Server to server: no cookie, no CSRF headers; the HMAC over the raw body is the only credential. */
  @Post('webhook')
  @Public()
  @SkipCsrf()
  // Lemon Squeezy retries any non-200, so a 429 would only add noise; the HMAC check is cheap.
  @SkipThrottle()
  @HttpCode(200)
  @ApiOperation({ operationId: 'billingWebhook', summary: 'Lemon Squeezy webhook; verified by HMAC in X-Signature. Exempt from CsrfGuard.' })
  @ApiHeader({ name: 'X-Signature', required: true, schema: { type: 'string' } })
  @ApiBody({ required: true, schema: { type: 'object', additionalProperties: true } })
  @ApiOkResponse({ description: 'Processed, or already processed (replay ignored).' })
  @ApiProblem(401)
  async webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-signature') signature: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    await this.webhooks.execute(req.rawBody, signature);
    // An empty 200 tells Lemon Squeezy the event is captured (any other status makes it retry).
    res.status(200).end();
  }
}
