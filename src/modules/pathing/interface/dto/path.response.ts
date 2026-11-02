import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import { Expose, Transform, Type } from 'class-transformer';

// Contract shapes for pathing responses; Topic and Position match catalog's and assessment's copies.
const STAGES = ['novice', 'advanced_beginner', 'competent', 'proficient', 'expert'];
const BLOOMS = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'];
const STEP_STATUSES = ['locked', 'active', 'completed', 'skipped'];
const TIMESTAMP = '^\\d{1,2}:\\d{2}(:\\d{2})?$';

@ApiSchema({ name: 'Topic' })
export class PathTopicDto {
  @ApiProperty({ type: String }) @Expose() id!: string;
  @ApiProperty({ type: String }) @Expose() canonicalName!: string;
  @ApiPropertyOptional({ type: String, isArray: true }) @Expose() aliases?: string[];
  @ApiPropertyOptional({ type: String, nullable: true }) @Expose() parentId?: string | null;
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

@ApiSchema({ name: 'Position' })
export class PathPositionDto {
  @ApiProperty({ enum: STAGES, enumName: 'DreyfusStage' }) @Expose() stage!: string;
  @ApiProperty({ enum: BLOOMS, enumName: 'BloomLevel' }) @Expose() bloom!: string;
}

@ApiSchema({ name: 'ResourceConcept' })
export class ResourceConceptDto {
  @ApiProperty({ type: String }) @Expose() name!: string;
  @ApiPropertyOptional({ type: String, nullable: true, pattern: TIMESTAMP }) @Expose() start?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, pattern: TIMESTAMP }) @Expose() end?: string | null;
}

@ApiSchema({ name: 'ResourceQuality' })
export class ResourceQualityDto {
  @ApiProperty({ type: 'integer', minimum: 0, maximum: 100 }) @Expose() relevance!: number;
  @ApiProperty({ type: 'integer', minimum: 0, maximum: 100 }) @Expose() accuracySignals!: number;
  @ApiProperty({ type: 'integer', minimum: 0, maximum: 100 }) @Expose() recency!: number;
  @ApiProperty({ type: 'integer', minimum: 0, maximum: 100 }) @Expose() teaching!: number;
}

/** Contract Resource: the public view of a ResourceCard (US-04). */
@ApiSchema({ name: 'Resource', description: 'Public view of a ResourceCard (US-04).' })
export class ResourceDto {
  @ApiProperty({ type: String }) @Expose() id!: string;
  @ApiProperty({ enum: ['youtube', 'article', 'official_doc', 'paper', 'related'], enumName: 'ResourceType' }) @Expose() type!: string;
  @ApiProperty({ type: String, format: 'uri' }) @Expose() url!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) @Expose() youtubeId?: string | null;
  @ApiProperty({ type: String }) @Expose() title!: string;
  @ApiProperty({ type: String }) @Expose() source!: string;
  @ApiPropertyOptional({ type: 'integer', nullable: true }) @Expose() durationMin?: number | null;
  @ApiPropertyOptional({ type: 'integer', nullable: true }) @Expose() readingMin?: number | null;
  @ApiPropertyOptional({ type: String, format: 'date', nullable: true }) @Expose() published?: string | null;
  @ApiPropertyOptional({ type: String }) @Expose() language?: string;
  @ApiProperty({ enum: STAGES, enumName: 'DreyfusStage' }) @Expose() stage!: string;
  @ApiProperty({ enum: BLOOMS, enumName: 'BloomLevel', isArray: true }) @Expose() bloomLevels!: string[];
  @ApiPropertyOptional({ type: String, isArray: true }) @Expose() prerequisites?: string[];
  @ApiPropertyOptional({ type: ResourceConceptDto, isArray: true }) @Expose() @Type(() => ResourceConceptDto) concepts?: ResourceConceptDto[];
  @ApiPropertyOptional({ type: String, isArray: true, maxItems: 5 }) @Expose() keyTakeaways?: string[];
  @ApiPropertyOptional({ type: String }) @Expose() whyThis?: string;
  @ApiPropertyOptional({ type: ResourceQualityDto }) @Expose() @Type(() => ResourceQualityDto) quality?: ResourceQualityDto;
}

export class CheckpointItemOptionDto {
  @ApiProperty({ type: String }) @Expose() id!: string;
  @ApiProperty({ type: String }) @Expose() label!: string;
}

/** Contract CheckpointItem; never carries the answer key. */
@ApiSchema({ name: 'CheckpointItem' })
export class CheckpointItemDto {
  @ApiProperty({ type: String }) @Expose() id!: string;
  @ApiProperty({ enum: ['single_choice', 'multi_choice', 'short_answer', 'open'] }) @Expose() kind!: string;
  @ApiProperty({ type: String }) @Expose() prompt!: string;
  @ApiPropertyOptional({ type: CheckpointItemOptionDto, isArray: true }) @Expose() @Type(() => CheckpointItemOptionDto) options?: CheckpointItemOptionDto[];
}

@ApiSchema({ name: 'Checkpoint' })
export class CheckpointDto {
  @ApiProperty({ type: CheckpointItemDto, isArray: true, minItems: 1 }) @Expose() @Type(() => CheckpointItemDto) items!: CheckpointItemDto[];
  @ApiPropertyOptional({ type: String, isArray: true }) @Expose() rubric?: string[];
  @ApiProperty({ type: 'integer', minimum: 0, maximum: 100, default: 80 }) @Expose() passScore!: number;
  @ApiPropertyOptional({ type: 'integer', minimum: 0 }) @Expose() attempts?: number;
  @ApiPropertyOptional({ type: 'integer', nullable: true }) @Expose() lastScore?: number | null;
}

export class StepActionDto {
  @ApiProperty({ type: 'integer' }) @Expose() n!: number;
  @ApiProperty({ type: String }) @Expose() text!: string;
  @ApiProperty({ type: Boolean }) @Expose() done!: boolean;
}

@ApiSchema({ name: 'PathStep' })
export class PathStepDto {
  @ApiProperty({ type: String }) @Expose() id!: string;
  @ApiProperty({ type: 'integer', minimum: 1 }) @Expose() n!: number;
  @ApiProperty({ type: String }) @Expose() objective!: string;
  @ApiProperty({ enum: BLOOMS, enumName: 'BloomLevel' }) @Expose() bloom!: string;
  @ApiProperty({ type: StepActionDto, isArray: true }) @Expose() @Type(() => StepActionDto) actions!: StepActionDto[];
  @ApiProperty({ type: ResourceDto, isArray: true, minItems: 1, maxItems: 3 }) @Expose() @Type(() => ResourceDto) resources!: ResourceDto[];
  @ApiProperty({ type: CheckpointDto }) @Expose() @Type(() => CheckpointDto) checkpoint!: CheckpointDto;
  @ApiProperty({ type: String }) @Expose() doneWhen!: string;
  @ApiProperty({ type: 'integer', minimum: 1 }) @Expose() estMinutes!: number;
  @ApiProperty({ enum: STEP_STATUSES, enumName: 'StepStatus' }) @Expose() status!: string;
  @ApiPropertyOptional({ type: Boolean, default: false }) @Expose() remedial?: boolean;
  @ApiPropertyOptional({ enum: ['too_easy', 'ok', 'too_hard', null], nullable: true }) @Expose() difficulty?: string | null;
}

@ApiSchema({ name: 'PathStepSummary' })
export class PathStepSummaryDto {
  @ApiProperty({ type: String }) @Expose() id!: string;
  @ApiProperty({ type: 'integer', minimum: 1 }) @Expose() n!: number;
  @ApiProperty({ type: String }) @Expose() objective!: string;
  @ApiProperty({ enum: BLOOMS, enumName: 'BloomLevel' }) @Expose() bloom!: string;
  @ApiProperty({ type: 'integer', minimum: 1 }) @Expose() estMinutes!: number;
  @ApiProperty({ enum: STEP_STATUSES, enumName: 'StepStatus' }) @Expose() status!: string;
}

@ApiSchema({ name: 'PathSummary' })
export class PathSummaryDto {
  @ApiProperty({ type: String }) @Expose() id!: string;
  @ApiProperty({ type: PathTopicDto }) @Expose() @Type(() => PathTopicDto) topic!: PathTopicDto;
  @ApiProperty({ type: PathPositionDto }) @Expose() @Type(() => PathPositionDto) from!: PathPositionDto;
  @ApiProperty({ type: PathPositionDto }) @Expose() @Type(() => PathPositionDto) to!: PathPositionDto;
  @ApiProperty({ enum: ['generating', 'active', 'completed', 'failed', 'under_review'] }) @Expose() status!: string;
  @ApiPropertyOptional({ type: Number }) @Expose() totalHours?: number;
  @ApiPropertyOptional({ type: 'integer' }) @Expose() stepsDone?: number;
  @ApiPropertyOptional({ type: 'integer' }) @Expose() stepsTotal?: number;
  @ApiProperty({ type: String, format: 'date-time' }) @Expose() createdAt!: string;
  @ApiPropertyOptional({
    description: 'The first step that is not done yet, so Today renders from the list alone. Null when the path is not active or every step is done.',
    oneOf: [{ $ref: '#/components/schemas/PathStepSummary' }, { type: 'null' }],
  })
  @Expose()
  @Type(() => PathStepSummaryDto)
  currentStep?: PathStepSummaryDto | null;
}

@ApiSchema({ name: 'Path' })
export class PathDto extends PathSummaryDto {
  @ApiProperty({ type: PathStepDto, isArray: true, minItems: 6, description: '6–12 generated steps, plus any inserted remedial steps.' })
  @Expose()
  @Type(() => PathStepDto)
  steps!: PathStepDto[];
}

@ApiSchema({ name: 'PathListResponse' })
export class PathListResponseDto {
  @ApiProperty({ type: PathSummaryDto, isArray: true }) @Expose() @Type(() => PathSummaryDto) items!: PathSummaryDto[];
  @ApiPropertyOptional({ type: String, nullable: true }) @Expose() nextCursor?: string | null;
}

@ApiSchema({ name: 'JobAccepted' })
export class JobAcceptedDto {
  @ApiProperty({ type: String }) @Expose() jobId!: string;
  @ApiProperty({ enum: ['queued', 'running', 'succeeded', 'failed', 'dead'], enumName: 'JobStatus' }) @Expose() status!: string;
  @ApiProperty({ type: String }) @Expose() eventsUrl!: string;
}
