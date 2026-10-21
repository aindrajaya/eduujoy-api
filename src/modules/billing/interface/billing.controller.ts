import { Body, Controller, Headers, HttpCode, Post, type RawBodyRequest, Req, Res, SerializeOptions, UseInterceptors } from '@nestjs/common';
import { ApiBody, ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { type Request, type Response } from 'express';
import { type AuthUser, CurrentUser, Public, SkipCsrf } from '../../../shared/common/auth';
import { ApiAccessCookieAuth, ApiCsrfHeader, ApiProblem } from '../../../shared/common/openapi';
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
  @ApiOperation({ operationId: 'billingCheckout', summary: 'Create a Lemon Squeezy checkout link (FR-23).' })
  @ApiCsrfHeader()
  @ApiOkResponse({ description: 'Checkout URL.', type: CheckoutResponseDto })
  @ApiProblem(400)
  @ApiProblem(401)
  checkout(@CurrentUser() user: AuthUser, @Body() body: CheckoutRequestDto): Promise<{ url: string }> {
    return this.checkouts.execute(user.userId, body.product);
  }

  /** Server to server: no cookie, no CSRF headers; the HMAC over the raw body is the only credential. */
  @Post('webhook')
  @Public()
  @SkipCsrf()
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
