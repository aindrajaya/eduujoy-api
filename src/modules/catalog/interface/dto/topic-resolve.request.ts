import { ApiProperty, ApiSchema } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/** Contract TopicResolveRequest: English free text (FR-01). */
@ApiSchema({ name: 'TopicResolveRequest' })
export class TopicResolveRequestDto {
  @ApiProperty({ type: String, minLength: 2, maxLength: 120 })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  text!: string;
}
