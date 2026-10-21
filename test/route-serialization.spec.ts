import { Controller, Get, HttpCode, Post, Res, SerializeOptions } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Expose } from 'class-transformer';
import { type Response } from 'express';
import { routesMissingResponseDto } from './route-serialization';

class BodyDto {
  @Expose() id!: string;
}

@Controller('sample')
class SampleController {
  @Get('typed')
  @SerializeOptions({ type: BodyDto })
  typed(): BodyDto {
    return { id: '1' };
  }

  @Get('untyped')
  untyped(): BodyDto {
    return { id: '1' };
  }

  @Post('empty')
  @HttpCode(204)
  empty(): void {
    return undefined;
  }

  @Get('redirect')
  redirect(@Res() res: Response): void {
    res.redirect(302, '/');
  }

  @Get('passthrough')
  passthrough(@Res({ passthrough: true }) res: Response): BodyDto {
    res.setHeader('x', '1');
    return { id: '1' };
  }
}

@SerializeOptions({ type: BodyDto })
@Controller('typed-class')
class TypedClassController {
  @Get()
  get(): BodyDto {
    return { id: '1' };
  }
}

describe('routesMissingResponseDto', () => {
  it('flags only body-returning routes without a response DTO', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [SampleController, TypedClassController],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    const missing = routesMissingResponseDto(app);
    await app.close();

    expect(missing).toEqual([
      'SampleController.passthrough (method 0, path passthrough)',
      'SampleController.untyped (method 0, path untyped)',
    ]);
  });
});
