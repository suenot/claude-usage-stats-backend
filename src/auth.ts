import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

const DEFAULT_AUTH_ISSUER = 'auth.marketmaker.cc';
const DEFAULT_AUTH_JWKS_URL = 'https://auth.marketmaker.cc/.well-known/jwks.json';
const DEFAULT_AUTH_SERVICE = 'harness-analyzer';

export interface AuthIdentity {
  subject: string;
  email?: string;
  username?: string;
  services: Record<string, string>;
}

export type AuthVerifier = (token: string) => Promise<AuthIdentity>;

export class ForbiddenError extends Error {
  constructor(message = 'Forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

function readServices(payload: JWTPayload): Record<string, string> {
  if (!payload.services || typeof payload.services !== 'object' || Array.isArray(payload.services)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(payload.services).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

export function createAuthVerifier(options: {
  jwksUrl?: string;
  issuer?: string;
  service?: string;
} = {}): AuthVerifier {
  const jwks = createRemoteJWKSet(new URL(options.jwksUrl || process.env.AUTH_JWKS_URL || DEFAULT_AUTH_JWKS_URL));
  const issuer = options.issuer || process.env.AUTH_ISSUER || DEFAULT_AUTH_ISSUER;
  const service = options.service || process.env.AUTH_SERVICE_NAME || DEFAULT_AUTH_SERVICE;

  return async (token: string) => {
    const { payload } = await jwtVerify(token, jwks, {
      algorithms: ['RS256'],
      issuer,
    });
    const services = readServices(payload);
    if (services[service] !== 'admin') throw new ForbiddenError();
    if (!payload.sub) throw new Error('JWT subject is missing');
    return {
      subject: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      username: typeof payload.username === 'string' ? payload.username : undefined,
      services,
    };
  };
}

export const verifyHarnessAccess = createAuthVerifier();
