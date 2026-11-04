import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { EndpointRateLimitService } from '../services/endpoint-rate-limit.service';

interface RateLimitRequest {
  route?: { path?: string };
  url: string;
  method: string;
  user?: { sub?: string; id?: string };
  ip?: string;
}

interface RateLimitResponse {
  setHeader(name: string, value: string | number): void;
}

@Injectable()
export class EndpointRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(EndpointRateLimitGuard.name);

  constructor(
    private readonly endpointRateLimitService: EndpointRateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RateLimitRequest>();
    const response = context.switchToHttp().getResponse<RateLimitResponse>();

    const endpoint = request.route?.path || request.url;
    const method = request.method;

    const userId = request.user?.sub ?? request.user?.id;
    const clientId = userId
      ? `user:${userId}`
      : `ip:${request.ip ?? 'unknown'}`;

    try {
      const result = await this.endpointRateLimitService.checkRateLimit(
        endpoint,
        method,
        clientId,
      );

      response.setHeader('X-RateLimit-Remaining', result.remaining);

      if (!result.allowed) {
        const retryAfterSecs = Math.ceil(result.retryAfterMs / 1000);
        response.setHeader('Retry-After', retryAfterSecs);
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message:
              'Rate limit exceeded for this endpoint. Please try again later.',
            error: 'Too Many Requests',
            retryAfter: retryAfterSecs,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      return true;
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(`Endpoint rate limit check failed: ${message}`);
      throw new HttpException(
        {
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: 'Rate limit service unavailable',
          error: 'Internal Server Error',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
