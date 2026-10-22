import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import { Expose, Transform, Type } from 'class-transformer';

const STAGES = ['novice', 'advanced_beginner', 'competent', 'proficient', 'expert'];
const BLOOMS = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'];

@ApiSchema({ name: 'DiagnosticItemOption' })
export class DiagnosticItemOptionDto {
  @ApiProperty({ type: String }) @Expose() id!: string;
  @ApiProperty({ type: String }) @Expose() label!: string;
}

/** Contract DiagnosticItem; never carries the answer key. */
@ApiSchema({ name: 'DiagnosticItem' })
export class DiagnosticItemDto {
  @ApiProperty({ type: String }) @Expose() id!: string;
  @ApiProperty({ enum: ['single_choice', 'multi_choice', 'short_answer', 'scenario'] }) @Expose() kind!: string;
  @ApiProperty({ enum: BLOOMS, enumName: 'BloomLevel' }) @Expose() bloom!: string;
  @ApiProperty({ type: String, description: 'Markdown; may contain KaTeX math.' }) @Expose() prompt!: string;
  @ApiPropertyOptional({ type: DiagnosticItemOptionDto, isArray: true })
  @Expose()
  @Type(() => DiagnosticItemOptionDto)
  options?: DiagnosticItemOptionDto[];
}

@ApiSchema({ name: 'Position' })
export class PositionDto {
  @ApiProperty({ enum: STAGES, enumName: 'DreyfusStage' }) @Expose() stage!: string;
  @ApiProperty({ enum: BLOOMS, enumName: 'BloomLevel' }) @Expose() bloom!: string;
}

@ApiSchema({ name: 'Placement' })
export class PlacementDto {
  @ApiProperty({ type: String }) @Expose() id!: string;
  @ApiProperty({ type: PositionDto }) @Expose() @Type(() => PositionDto) position!: PositionDto;
  @ApiProperty({ type: Number, minimum: 0, maximum: 1 }) @Expose() confidence!: number;
  @ApiProperty({ type: String, description: 'One-line reason (US-02).' }) @Expose() reason!: string;
}

@ApiSchema({ name: 'DiagnosticProgress' })
export class DiagnosticProgressDto {
  @ApiProperty({ type: 'integer' }) @Expose() answered!: number;
  @ApiProperty({ type: 'integer' }) @Expose() estimatedTotal!: number;
}

@ApiSchema({ name: 'DiagnosticBatchResponse' })
export class DiagnosticBatchResponseDto {
  @ApiProperty({ type: String }) @Expose() diagnosticId!: string;
  @ApiProperty({ enum: ['in_progress', 'completed'] }) @Expose() status!: string;
  @ApiProperty({ type: DiagnosticProgressDto }) @Expose() @Type(() => DiagnosticProgressDto) progress!: DiagnosticProgressDto;
  @ApiPropertyOptional({ type: DiagnosticItemDto, isArray: true, maxItems: 4 })
  @Expose()
  @Type(() => DiagnosticItemDto)
  items?: DiagnosticItemDto[];
  @ApiPropertyOptional({ type: PlacementDto }) @Expose() @Type(() => PlacementDto) placement?: PlacementDto;
}

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
  @ApiPropertyOptional({
    type: Boolean,
    description: 'True when the topic has a diagnostic item bank; false for new or learner-created topics until one is generated.',
  })
  @Expose()
  hasDiagnostic?: boolean;
}

/** Contract DiagnosticResponse (0.2.0): the batch shape plus topic and timestamps. */
@ApiSchema({ name: 'DiagnosticResponse' })
export class DiagnosticResponseDto extends DiagnosticBatchResponseDto {
  @ApiProperty({ type: TopicDto }) @Expose() @Type(() => TopicDto) topic!: TopicDto;
  @ApiProperty({ type: String, format: 'date-time' }) @Expose() createdAt!: Date;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true }) @Expose() completedAt?: Date | null;
}
