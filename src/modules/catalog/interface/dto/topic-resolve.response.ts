import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import { Expose, Transform, Type } from 'class-transformer';

/**
 * Contract schema Topic. Assessment declares the same schema for DiagnosticResponse (interface layers
 * can't import each other); `pnpm openapi:check` keeps both equal to the contract.
 */
@ApiSchema({ name: 'Topic' })
export class TopicDto {
  @ApiProperty({ type: String }) @Expose() id!: string;
  @ApiProperty({ type: String }) @Expose() canonicalName!: string;
  @ApiPropertyOptional({ type: String, isArray: true }) @Expose() aliases?: string[];
  @ApiPropertyOptional({ type: String, nullable: true }) @Expose() parentId?: string | null;
  // The contract's description is a plain string, so a missing description is omitted, not null.
  @ApiPropertyOptional({ type: String })
  @Expose()
  @Transform(({ value }: { value: unknown }) => (value === null ? undefined : value))
  description?: string;
}

export class TopicChoiceDto extends TopicDto {
  @ApiPropertyOptional({ type: Number, minimum: 0, maximum: 1 }) @Expose() similarity?: number;
}

/** Contract TopicResolveResponse. */
@ApiSchema({
  name: 'TopicResolveResponse',
  description:
    "`matched` (similarity at or above the server's match threshold), `choices` (at most 3, between the choice and match thresholds), or `created` (new topic). Thresholds are server-side and may be tuned.",
})
export class TopicResolveResponseDto {
  @ApiProperty({ enum: ['matched', 'choices', 'created'] }) @Expose() status!: 'matched' | 'choices' | 'created';
  @ApiPropertyOptional({ type: TopicDto }) @Expose() @Type(() => TopicDto) topic?: TopicDto;
  @ApiPropertyOptional({ type: TopicChoiceDto, isArray: true, maxItems: 3 }) @Expose() @Type(() => TopicChoiceDto) choices?: TopicChoiceDto[];
}
