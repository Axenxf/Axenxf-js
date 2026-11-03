import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { DataSource } from 'typeorm';
import { Queue } from 'bull';

const packageJson = JSON.parse(
  readFileSync(join(__dirname, '../package.json'), 'utf8'),
) as {
  name?: string;
  version?: string;
  description?: string;
};

export type AppHealthInfo = {
  name: string;
  version: string;
  description: string;
  environment: string;
  status: 'ok';
  uptimeSeconds: number;
  timestamp: string;
};

export type AppHealthStatus = {
  status: 'ok';
  service: string;
  uptimeSeconds: number;
};

@Injectable()
export class AppService implements OnApplicationShutdown {
  private readonly logger = new Logger(AppService.name);

  constructor(
    private readonly dataSource: DataSource,
    @Optional() @InjectQueue('default') private readonly defaultQueue?: Queue,
  ) {}

  getHello(): string {
    return 'Hello World!';
  }

  getHealth(): AppHealthStatus {
    return {
      status: 'ok',
      service: packageJson.name ?? 'Axenxf-js',
      uptimeSeconds: Number(process.uptime().toFixed(3)),
    };
  }

  getInfo(): AppHealthInfo {
    return {
      name: packageJson.name ?? 'Axenxf-js',
      version: packageJson.version ?? '0.0.0',
      description:
        packageJson.description ?? 'Axenxf financial platform REST API',
      environment: process.env.NODE_ENV ?? 'development',
      status: 'ok',
      uptimeSeconds: Number(process.uptime().toFixed(3)),
      timestamp: new Date().toISOString(),
    };
  }

  async onApplicationShutdown(signal?: string) {
    this.logger.log(`Shutdown started by ${signal ?? 'unknown signal'}`);
    const drainPromise = (async () => {
      if (this.defaultQueue) {
        await this.defaultQueue.pause(true);
        await this.defaultQueue.close();
        this.logger.log('Bull default queue drained and closed');
      }
      if (this.dataSource?.isInitialized) {
        await this.dataSource.destroy();
        this.logger.log('Database connection closed');
      }
    })();

    await Promise.race([
      drainPromise,
      new Promise((resolve) => setTimeout(resolve, 30000)),
    ]);
    this.logger.log('Shutdown completed');
  }
}
