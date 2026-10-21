import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

// Bounds mirror DiagnosticStartRequest and DiagnosticAnswersRequest in the frozen contract.
const FORMATS = ['video', 'text', 'papers'] as const;

export class SelfReportDto {
  @ApiPropertyOptional({ type: Number, minimum: 0, maximum: 50 })
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(50)
  years?: number;

  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: 1000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  projectsShipped?: number;
}

@ApiSchema({ name: 'DiagnosticStartRequest' })
export class DiagnosticStartRequestDto {
  @ApiProperty({ type: String })
  @IsString()
  @MaxLength(64)
  topicId!: string;

  @ApiProperty({ type: String, minLength: 3, maxLength: 500 })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  goal!: string;

  @ApiProperty({ type: Number, minimum: 1, maximum: 40 })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(1)
  @Max(40)
  weeklyHours!: number;

  @ApiPropertyOptional({ enum: FORMATS, enumName: 'ResourceFormat', isArray: true, maxItems: 3, uniqueItems: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @ArrayUnique()
  @IsIn(FORMATS, { each: true })
  preferredFormats?: (typeof FORMATS)[number][];

  @ApiPropertyOptional({ type: SelfReportDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SelfReportDto)
  selfReport?: SelfReportDto;
}

@ApiSchema({ name: 'DiagnosticAnswer' })
export class DiagnosticAnswerDto {
  @ApiProperty({ type: String })
  @IsString()
  @MaxLength(64)
  itemId!: string;

  @ApiPropertyOptional({ type: String, isArray: true, maxItems: 10 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  optionIds?: string[];

  @ApiPropertyOptional({ type: String, maxLength: 4000 })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  text?: string;

  @ApiPropertyOptional({ type: Boolean, default: false })
  @IsOptional()
  @IsBoolean()
  skipped?: boolean;
}

@ApiSchema({ name: 'DiagnosticAnswersRequest' })
export class DiagnosticAnswersRequestDto {
  @ApiProperty({ type: DiagnosticAnswerDto, isArray: true, minItems: 1, maxItems: 50 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => DiagnosticAnswerDto)
  answers!: DiagnosticAnswerDto[];
}
