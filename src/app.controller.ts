import { SkipThrottle } from '@nestjs/throttler';
import { Controller, Get, Post, Body } from '@nestjs/common';
import { AppService } from './app.service';
import { Public } from './auth/decorators/public.decorator';
import { CreateCatDto } from './dtos/create-cat.dto';

@SkipThrottle()
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Public()
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Public()
  @Get('health')
  getHealth() {
    return this.appService.getHealth();
  }

  @Public()
  @Get('info')
  getInfo() {
    return this.appService.getInfo();
  }

  @Post('cats')
  createCat(@Body() createCatDto: CreateCatDto) {
    void createCatDto;
    return 'This action adds a new cat';
  }
}
