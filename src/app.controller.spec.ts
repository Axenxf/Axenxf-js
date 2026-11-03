import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bull';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        {
          provide: getDataSourceToken(),
          useValue: { isInitialized: false, destroy: jest.fn() },
        },
        {
          provide: getQueueToken('default'),
          useValue: null,
        },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(appController.getHello()).toBe('Hello World!');
    });
  });

  describe('info', () => {
    it('should return application metadata including health status', () => {
      const info = appController.getInfo();

      expect(info.name).toBe('Axenxf-js');
      expect(info.status).toBe('ok');
      expect(typeof info.environment).toBe('string');
      expect(typeof info.version).toBe('string');
      expect(typeof info.uptimeSeconds).toBe('number');
    });
  });
});
