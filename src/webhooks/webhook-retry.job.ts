import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { WebhooksService } from './webhooks.service';

@Injectable()
export class WebhookRetryJob {
  private readonly logger = new Logger(WebhookRetryJob.name);
  constructor(private readonly webhooksService: WebhooksService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async runRetrySweep() {
    this.logger.log('Running webhook cron-based retry sweep...');
    const recovered = await this.webhooksService.recoverFailedDeliveries();
    this.logger.log(`Queued ${recovered} webhook delivery retry(s)`);
  }

  manualRetry(deliveryId: string, ownerId: string) {
    return this.webhooksService.manualRetry(deliveryId, ownerId);
  }
}
