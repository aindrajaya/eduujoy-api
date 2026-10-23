import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';

// Bounds mirror PathCreateRequest and StepPatchRequest in the frozen contract.

@ApiSchema({ name: 'PathCreateRequest' })
export class PathCreateRequestDto {
  @ApiProperty({ type: String })
  @IsString()
  @MaxLength(64)
  placementId!: string;

  @ApiPropertyOptional({ type: String, maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  goal?: string;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 40 })
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(1)
  @Max(40)
  weeklyHours?: number;
}

export class ActionDoneDto {
  @ApiProperty({ type: 'integer', minimum: 1 })
  @IsInt()
  @Min(1)
  @Max(100)
  n!: number;

  @ApiProperty({ type: Boolean })
  @IsBoolean()
  done!: boolean;
}

@ApiSchema({ name: 'StepPatchRequest' })
export class StepPatchRequestDto {
  @ApiPropertyOptional({ type: ActionDoneDto, isArray: true, maxItems: 50 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ActionDoneDto)
  actionsDone?: ActionDoneDto[];

  @ApiPropertyOptional({ enum: ['too_easy', 'ok', 'too_hard'] })
  @IsOptional()
  @IsIn(['too_easy', 'ok', 'too_hard'])
  difficulty?: 'too_easy' | 'ok' | 'too_hard';

  @ApiPropertyOptional({ enum: ['completed', 'skipped'] })
  @IsOptional()
  @IsIn(['completed', 'skipped'])
  status?: 'completed' | 'skipped';
}

export class PathListQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  topicId?: string;

  @IsOptional()
  @IsIn(['generating', 'active', 'completed', 'failed', 'under_review'])
  status?: 'generating' | 'active' | 'completed' | 'failed' | 'under_review';

  @IsOptional()
  @IsString()
  @MaxLength(256)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
