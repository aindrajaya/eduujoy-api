import { ApiProperty, ApiSchema } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { IsIn } from 'class-validator';

/** Contract CheckoutRequest: the quantity of credit packs is chosen on Lemon Squeezy's page (user decision). */
@ApiSchema({ name: 'CheckoutRequest' })
export class CheckoutRequestDto {
  @ApiProperty({ enum: ['subscription', 'credit_pack'] })
  @IsIn(['subscription', 'credit_pack'])
  product!: 'subscription' | 'credit_pack';
}

@ApiSchema({ name: 'CheckoutResponse' })
export class CheckoutResponseDto {
  @ApiProperty({ type: String, format: 'uri' }) @Expose() url!: string;
}
