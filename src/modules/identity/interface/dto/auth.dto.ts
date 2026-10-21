import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

// Bounds mirror RegisterRequest and LoginRequest in the frozen contract.

export class RegisterRequestDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(128)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;
}

export class LoginRequestDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;
}
