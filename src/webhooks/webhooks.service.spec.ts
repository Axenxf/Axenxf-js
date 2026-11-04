import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { FindManyOptions } from 'typeorm';
import { WebhooksService } from './webhooks.service';
import { WebhookEndpoint } from './webhook-endpoint.entity';
import {
  WebhookDelivery,
  WebhookDeliveryStatus,
} from './webhook-delivery.entity';
import { getQueueToken } from '@nestjs/bull';

/**
 * #1446: `listDeliveries` used to read the entire `webhook_deliveries` table
 * and filter in JavaScript. These tests assert the query is scoped and
 * paginated at the database level (one `findAndCount`, bounded `take`), that an
 * unowned endpoint is a 404, and that the request body is omitted from the
 * list.
 */
describe('WebhooksService.listDeliveries (#1446)', () => {
  let service: WebhooksService;
  let endpointsRepository: {
    find: jest.Mock;
    findOne: jest.Mock;
  };
  let deliveriesRepository: {
    findAndCount: jest.Mock<Promise<[unknown[], number]>, [FindManyOptions]>;
    delete: jest.Mock<Promise<{ affected?: number }>, [FindManyOptions]>;
    find: jest.Mock<Promise<WebhookDelivery[]>, [FindManyOptions]>;
    save: jest.Mock<Promise<WebhookDelivery>, [WebhookDelivery]>;
    createQueryBuilder: jest.Mock;
  };
  let deliveryQuery: {
    innerJoin: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    getOne: jest.Mock;
  };
  let webhooksQueue: { add: jest.Mock };

  const endpoint = { id: 'ep-1', ownerId: 'owner-1' } as WebhookEndpoint;

  beforeEach(async () => {
    endpointsRepository = {
      find: jest.fn().mockResolvedValue([endpoint]),
      findOne: jest.fn(),
    };
    deliveryQuery = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn(),
    };
    deliveriesRepository = {
      findAndCount: jest
        .fn<Promise<[unknown[], number]>, [FindManyOptions]>()
        .mockResolvedValue([[], 0]),
      delete: jest
        .fn<Promise<{ affected?: number }>, [FindManyOptions]>()
        .mockResolvedValue({ affected: 0 }),
      find: jest
        .fn<Promise<WebhookDelivery[]>, [FindManyOptions]>()
        .mockResolvedValue([]),
      save: jest
        .fn<Promise<WebhookDelivery>, [WebhookDelivery]>()
        .mockImplementation((delivery) => Promise.resolve(delivery)),
      createQueryBuilder: jest.fn(() => deliveryQuery),
    };
    webhooksQueue = { add: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhooksService,
        {
          provide: getRepositoryToken(WebhookEndpoint),
          useValue: endpointsRepository,
        },
        {
          provide: getRepositoryToken(WebhookDelivery),
          useValue: deliveriesRepository,
        },
        { provide: getQueueToken('webhooks'), useValue: webhooksQueue },
      ],
    }).compile();

    service = module.get(WebhooksService);
  });

  it('queries a single bounded page instead of the whole table', async () => {
    await service.listDeliveries('owner-1', undefined, { page: 2, limit: 10 });

    expect(deliveriesRepository.findAndCount).toHaveBeenCalledTimes(1);
    expect(deliveriesRepository.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 10, take: 10 }),
    );
  });

  it('scopes the query to the caller via their owned endpoints', async () => {
    await service.listDeliveries('owner-1');

    const arg = deliveriesRepository.findAndCount.mock.calls[0][0];
    expect(arg.where.endpointId).toMatchObject({
      _type: 'in',
      _value: ['ep-1'],
    });
  });

  it('applies the requested status filter at the database level', async () => {
    await service.listDeliveries('owner-1', undefined, {
      status: WebhookDeliveryStatus.FAILED,
    });

    const arg = deliveriesRepository.findAndCount.mock.calls[0][0];
    expect(arg.where.status).toBe(WebhookDeliveryStatus.FAILED);
  });

  it('caps the page size at the maximum', async () => {
    await service.listDeliveries('owner-1', undefined, { limit: 5000 });

    const arg = deliveriesRepository.findAndCount.mock.calls[0][0];
    expect(arg.take).toBe(100);
  });

  it('returns pagination metadata with the page', async () => {
    deliveriesRepository.findAndCount.mockResolvedValue([[{ id: 'd1' }], 42]);

    const result = await service.listDeliveries('owner-1', undefined, {
      page: 3,
      limit: 20,
    });

    expect(result).toMatchObject({ total: 42, page: 3, limit: 20 });
    expect(result.items).toHaveLength(1);
  });

  it('omits the stored request body from list items', async () => {
    deliveriesRepository.findAndCount.mockResolvedValue([
      [{ id: 'd1', requestBody: { secret: 'payload' }, status: 'success' }],
      1,
    ]);

    const result = await service.listDeliveries('owner-1');

    expect(result.items[0]).not.toHaveProperty('requestBody');
    expect(result.items[0]).toMatchObject({ id: 'd1' });
  });

  it('404s when the endpoint is not owned by the caller', async () => {
    endpointsRepository.findOne.mockResolvedValue(null);

    await expect(
      service.listDeliveries('owner-1', 'not-mine'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(deliveriesRepository.findAndCount).not.toHaveBeenCalled();
  });

  describe('retention', () => {
    it('prunes rows older than the retention window', async () => {
      deliveriesRepository.delete.mockResolvedValue({ affected: 7 });

      const deleted = await service.pruneExpiredDeliveries(30);

      expect(deleted).toBe(7);
      const arg = deliveriesRepository.delete.mock.calls[0][0];
      expect(arg.createdAt).toMatchObject({ _type: 'lessThan' });
    });

    it('deletes nothing when retention is disabled', async () => {
      const deleted = await service.pruneExpiredDeliveries(0);

      expect(deleted).toBe(0);
      expect(deliveriesRepository.delete).not.toHaveBeenCalled();
    });
  });

  describe('retry', () => {
    it('retries only deliveries owned by the requesting user', async () => {
      const delivery = {
        id: 'delivery-1',
        status: WebhookDeliveryStatus.FAILED,
        retryCount: 0,
        maxRetries: 2,
      } as WebhookDelivery;
      deliveryQuery.getOne.mockResolvedValue(delivery);

      await service.manualRetry('delivery-1', 'owner-1');

      expect(deliveryQuery.andWhere).toHaveBeenCalledWith(
        'endpoint.ownerId = :ownerId',
        { ownerId: 'owner-1' },
      );
      const manualRetryJobId: unknown =
        expect.stringContaining('retry-delivery-1');
      const manualRetryOptions: unknown = expect.objectContaining({
        jobId: manualRetryJobId,
      });
      expect(webhooksQueue.add).toHaveBeenCalledWith(
        'deliver',
        { deliveryId: 'delivery-1' },
        manualRetryOptions,
      );
      expect(delivery.retryCount).toBe(1);
      expect(delivery.status).toBe(WebhookDeliveryStatus.PENDING);
    });

    it('recovers failed deliveries only below their retry limit', async () => {
      const retryable = {
        id: 'retryable',
        status: WebhookDeliveryStatus.FAILED,
        retryCount: 0,
        maxRetries: 1,
      } as WebhookDelivery;
      const exhausted = {
        id: 'exhausted',
        status: WebhookDeliveryStatus.FAILED,
        retryCount: 1,
        maxRetries: 1,
      } as WebhookDelivery;
      deliveriesRepository.find.mockResolvedValue([retryable, exhausted]);

      await expect(service.recoverFailedDeliveries()).resolves.toBe(1);
      expect(webhooksQueue.add).toHaveBeenCalledTimes(1);
      const recoveryJobId: unknown = expect.stringContaining('retry-retryable');
      const recoveryOptions: unknown = expect.objectContaining({
        jobId: recoveryJobId,
      });
      expect(webhooksQueue.add).toHaveBeenCalledWith(
        'deliver',
        { deliveryId: 'retryable' },
        recoveryOptions,
      );
      expect(exhausted.retryCount).toBe(1);
    });
  });
});
