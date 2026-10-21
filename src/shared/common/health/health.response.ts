import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

@ApiSchema({ name: 'HealthResponse' })
export class HealthResponseDto {
  @ApiProperty({ enum: ['ok'] }) @Expose() status!: 'ok';
  @ApiPropertyOptional({ type: String }) @Expose() version?: string;
  @ApiPropertyOptional({ type: 'object', additionalProperties: { type: 'string' } })
  @Expose()
  checks?: Record<string, string>;
}
