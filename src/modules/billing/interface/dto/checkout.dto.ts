import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
  Validate,
  type ValidationArguments,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { MAX_PACK_QUANTITY } from '../../domain/billing-rules';

/** `quantity` belongs to credit packs; sent with a subscription it is a 400 (contract 0.7.0). */
@ValidatorConstraint({ name: 'quantityOnlyForCreditPack' })
class QuantityOnlyForCreditPack implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    return (args.object as { product?: unknown }).product === 'credit_pack';
  }

  defaultMessage(): string {
    return 'quantity is only allowed with product credit_pack';
  }
}

/** Contract CheckoutRequest (0.7.0): the app picks the pack quantity, since Lemon Squeezy has no max-quantity setting. */
@ApiSchema({ name: 'CheckoutRequest' })
export class CheckoutRequestDto {
  @ApiProperty({ enum: ['subscription', 'credit_pack'] })
  @IsIn(['subscription', 'credit_pack'])
  product!: 'subscription' | 'credit_pack';

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: MAX_PACK_QUANTITY,
    default: 1,
    description:
      'Credit packs to buy (credit_pack only; 400 if sent with subscription or outside 1–10). Preset on the Lemon Squeezy checkout; credits come only from the paid order in the webhook.',
  })
  @IsOptional()
  @Validate(QuantityOnlyForCreditPack)
  @IsInt()
  @Min(1)
  @Max(MAX_PACK_QUANTITY)
  quantity?: number;
}

@ApiSchema({ name: 'CheckoutResponse' })
export class CheckoutResponseDto {
  @ApiProperty({ type: String, format: 'uri' }) @Expose() url!: string;
}
