import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

// Bounds mirror RegisterRequest and LoginRequest in the frozen contract.

@ApiSchema({ name: 'RegisterRequest' })
export class RegisterRequestDto {
  @ApiProperty({ type: String, format: 'email', maxLength: 254 })
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ type: String, minLength: 10, maxLength: 128 })
  @IsString()
  @MinLength(10)
  @MaxLength(128)
  password!: string;

  @ApiPropertyOptional({ type: String, maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;
}

@ApiSchema({ name: 'LoginRequest' })
export class LoginRequestDto {
  @ApiProperty({ type: String, format: 'email', maxLength: 254 })
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;
}
