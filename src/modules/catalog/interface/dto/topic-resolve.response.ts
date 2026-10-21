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
@ApiSchema({ name: 'TopicResolveResponse', description: '`matched` (similarity ≥ 0.88), `choices` (0.75–0.88, at most 3), or `created` (new topic).' })
export class TopicResolveResponseDto {
  @ApiProperty({ enum: ['matched', 'choices', 'created'] }) @Expose() status!: 'matched' | 'choices' | 'created';
  @ApiPropertyOptional({ type: TopicDto }) @Expose() @Type(() => TopicDto) topic?: TopicDto;
  @ApiPropertyOptional({ type: TopicChoiceDto, isArray: true, maxItems: 3 }) @Expose() @Type(() => TopicChoiceDto) choices?: TopicChoiceDto[];
}
