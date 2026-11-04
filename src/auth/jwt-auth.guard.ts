import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { GqlExecutionContext } from '@nestjs/graphql';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';
import { AuthenticatedUser } from './authenticated-user.interface';
import { TokenType } from './token-types';
import { AccountStatusService } from './account-status.service';

interface JwtPayload {
  sub?: string;
  typ?: string;
  isEmailVerified?: boolean;
  email?: string;
  role?: string;
  roles?: string[];
  sid?: string;
  tv?: number;
  impersonation?: boolean;
  act?: { sub?: string };
}

interface AuthenticatedRequest {
  headers: {
    authorization?: string | string[];
  };
  user?: AuthenticatedUser;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
    @Optional() private readonly accountStatus?: AccountStatusService,
  ) {}

  private getRequest(context: ExecutionContext): AuthenticatedRequest {
    const contextType: string = context.getType();
    if (contextType === 'graphql') {
      return GqlExecutionContext.create(context).getContext<{
        req: AuthenticatedRequest;
      }>().req;
    }
    return context.switchToHttp().getRequest<AuthenticatedRequest>();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = this.getRequest(context);

    // Already authenticated by the API-key guard on an `@ApiKeyAllowed` route.
    if (request.user?.authMethod === 'api_key') {
      return true;
    }

    const authorization = request.headers.authorization;
    const bearerToken = Array.isArray(authorization)
      ? authorization[0]
      : authorization;
    const token =
      typeof bearerToken === 'string' && bearerToken.startsWith('Bearer ')
        ? bearerToken.slice(7)
        : undefined;

    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    let payload: JwtPayload;
    try {
      const secret = String(this.config.get('jwt.secret') ?? '');
      payload = this.jwtService.verify<JwtPayload>(token, { secret });
    } catch {
      throw new UnauthorizedException('Invalid authentication token');
    }

    if (payload.typ !== TokenType.ACCESS || !payload.sub) {
      throw new UnauthorizedException('Invalid authentication token');
    }

    // A signed token is not enough: suspended, deactivated and deleted users
    // lose access immediately even though their token has not expired.
    if (
      this.accountStatus &&
      !(await this.accountStatus.isAllowedToAuthenticate(payload.sub))
    ) {
      throw new UnauthorizedException('Account is not active');
    }

    request.user = {
      id: payload.sub,
      sub: payload.sub,
      email: payload.email ?? '',
      role: payload.role ?? '',
      isEmailVerified: payload.isEmailVerified,
      sid: payload.sid,
      tokenVersion: payload.tv,
      ...(payload.impersonation
        ? { impersonation: true, actorId: payload.act?.sub }
        : {}),
    };
    return true;
  }
}
