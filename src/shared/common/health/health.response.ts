import { Expose } from 'class-transformer';

/** Contract schema HealthResponse. */
export class HealthResponseDto {
  @Expose() status!: 'ok';
  @Expose() version?: string;
  @Expose() checks?: Record<string, string>;
}
