import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Contract TopicResolveRequest: English free text (FR-01). */
@ApiSchema({ name: 'TopicResolveRequest' })
export class TopicResolveRequestDto {
  @ApiProperty({ type: String, minLength: 2, maxLength: 120 })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  text!: string;

  @ApiPropertyOptional({
    type: Boolean,
    default: false,
    description: 'Skip matching and create a topic from `text` (after the learner rejected the choices). Subject to the daily new-topic cap (429).',
  })
  @IsOptional()
  @IsBoolean()
  createNew?: boolean;
}
