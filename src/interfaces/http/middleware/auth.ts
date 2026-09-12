/**
 * Authentication Middleware
 * 
 * Verifies JWT tokens and extracts tenantId/sessionId for storage context.
 * Supports multiple auth strategies:
 * - Firebase Auth
 * - Custom JWT (HS256/RS256)
 * - Development mode (no auth)
 */

import { randomUUID } from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { logger } from '../../../utils/logger.js';

export interface AuthContext {
  tenantId: string;
  sessionId: string;
  userId?: string;
  email?: string;
  /** Kai organization id — when present, storage uses the org/agent hierarchy. */
  organizationId?: string;
  /** Kai agent id — when present, storage uses the org/agent hierarchy. */
  agentId?: string;
  /** Kai conversation id — shared across sessions; conversation memory is keyed by it. */
  conversationId?: string;
  /** Kai contact (end-user) id. Required by the Kai flow alongside org/agent ids. */
  contactId?: string;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

/**
 * Headers Kai uses to supply its multi-organization metadata. When any of these
 * are present they take precedence over the dev-tenant fallback.
 */
const KAI_HEADERS = {
  organizationId: 'x-organization-id',
  agentId: 'x-agent-id',
  conversationId: 'x-conversation-id',
  contactId: 'x-contact-id',
  sessionId: 'x-session-id',
  tenantId: 'x-tenant-id',
} as const;

/**
 * Extract Kai metadata from request headers (REST) or query params (WebSocket).
 * Returns an empty object when nothing is supplied — callers fall back to the
 * tenantId/sessionId defaults (dev-tenant in dev mode, or JWT claims).
 */
function extractKaiMetadata(source: { get?: (name: string) => string | undefined; [key: string]: any }): Partial<AuthContext> {
  const value = (name: string) => {
    if (source && typeof source.get === 'function') {
      return source.get(name);
    }
    return source?.[name];
  };

  const organizationId = value(KAI_HEADERS.organizationId);
  const agentId = value(KAI_HEADERS.agentId);
  const conversationId = value(KAI_HEADERS.conversationId);
  const contactId = value(KAI_HEADERS.contactId);
  const sessionId = value(KAI_HEADERS.sessionId);
  const tenantId = value(KAI_HEADERS.tenantId);

  const meta: Partial<AuthContext> = {};
  if (organizationId) meta.organizationId = organizationId;
  if (agentId) meta.agentId = agentId;
  if (conversationId) meta.conversationId = conversationId;
  if (contactId) meta.contactId = contactId;
  if (sessionId) meta.sessionId = sessionId;
  if (tenantId) meta.tenantId = tenantId;
  return meta;
}

/**
 * Extract Kai metadata from JWT claims (organization_id / agent_id /
 * conversation_id / session_id / tenant_id). JWT claims use snake_case.
 */
function extractKaiClaims(payload: Record<string, any>): Partial<AuthContext> {
  const meta: Partial<AuthContext> = {};
  if (payload.organization_id) meta.organizationId = payload.organization_id;
  if (payload.agent_id) meta.agentId = payload.agent_id;
  if (payload.conversation_id) meta.conversationId = payload.conversation_id;
  if (payload.contact_id) meta.contactId = payload.contact_id;
  if (payload.session_id) meta.sessionId = payload.session_id;
  if (payload.tenant_id) meta.tenantId = payload.tenant_id;
  return meta;
}

/**
 * Merge Kai metadata over the base auth context — Kai-supplied org/agent ids
 * ALWAYS win over the derived/default values.
 */
function mergeKaiMetadata(base: AuthContext, kai: Partial<AuthContext>): AuthContext {
  return {
    ...base,
    ...kai,
    // Keep userId/email unless Kai supplies them
    userId: kai.userId ?? base.userId,
    email: kai.email ?? base.email,
  };
}

/**
 * Extract and verify JWT token
 */
export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // Development mode or auth disabled bypass
    if (process.env.AUTH_DISABLED === 'true') {
      logger.debug('[Auth] Auth disabled - bypassing authentication');
      // Kai metadata (headers) takes precedence; dev-tenant is ONLY a fallback.
      const kai = extractKaiMetadata(req.headers as any);
      req.auth = mergeKaiMetadata(
        {
          tenantId: req.headers['x-tenant-id'] as string || 'dev-tenant',
          sessionId: req.headers['x-session-id'] as string || generateSessionId(),
          userId: 'dev-user',
          email: 'dev@jiva.local',
        },
        kai,
      );
      next();
      return;
    }

    // Extract token
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid authorization header' });
      return;
    }

    const token = authHeader.substring(7);

    // Verify token based on strategy
    const authStrategy = process.env.AUTH_STRATEGY || 'custom';
    let authContext: AuthContext;

    switch (authStrategy) {
      case 'firebase':
        authContext = await verifyFirebaseToken(token);
        break;
      case 'custom':
        authContext = await verifyCustomToken(token);
        break;
      default:
        throw new Error(`Unknown auth strategy: ${authStrategy}`);
    }

    // Attach to request — Kai metadata from JWT claims is already merged inside
    // the verify functions; overlay any Kai-supplied headers as the final word.
    req.auth = mergeKaiMetadata(authContext, extractKaiMetadata(req.headers as any));
    next();

  } catch (error) {
    logger.error('[Auth] Authentication failed:', error);
    res.status(401).json({ 
      error: 'Authentication failed', 
      message: error instanceof Error ? error.message : 'Invalid token'
    });
  }
}

/**
 * Verify Firebase ID token
 */
async function verifyFirebaseToken(token: string): Promise<AuthContext> {
  // This would use firebase-admin SDK in production
  // For now, implement basic JWT parsing
  
  try {
    // Dynamic import to keep firebase-admin optional
    // @ts-expect-error - firebase-admin is an optional peer dependency
    const admin = await import('firebase-admin');
    
    if (!admin.apps.length) {
      // Initialize Firebase Admin if not already done
      const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT 
        ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
        : undefined;
      
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    }

    const decodedToken = await admin.auth().verifyIdToken(token);
    
    return mergeKaiMetadata({
      tenantId: decodedToken.uid, // Use Firebase UID as tenantId
      sessionId: decodedToken.session_id || generateSessionId(),
      userId: decodedToken.uid,
      email: decodedToken.email,
    }, extractKaiClaims(decodedToken));
  } catch (error) {
    logger.debug('[Auth] Firebase Admin not available, falling back to basic parsing');
    // Fallback: parse JWT without verification (dev only)
    return parseTokenBasic(token);
  }
}

/**
 * Verify custom JWT token
 */
async function verifyCustomToken(token: string): Promise<AuthContext> {
  const secret = process.env.JWT_SECRET;
  
  if (!secret) {
    throw new Error('JWT_SECRET not configured');
  }

  try {
    // Use jsonwebtoken library
    const jwt = await import('jsonwebtoken');
    const decoded = jwt.verify(token, secret) as any;

    if (!decoded.tenantId && !decoded.sub) {
      throw new Error('Token missing tenantId/sub claim');
    }

    return mergeKaiMetadata({
      tenantId: decoded.tenantId || decoded.sub,
      sessionId: decoded.sessionId || decoded.session_id || generateSessionId(),
      userId: decoded.userId || decoded.sub,
      email: decoded.email,
    }, extractKaiClaims(decoded));
  } catch (error) {
    logger.debug('[Auth] jsonwebtoken not available, falling back to basic parsing');
    // Fallback: parse JWT without verification (dev only)
    return parseTokenBasic(token);
  }
}

/**
 * Parse JWT token without verification (dev/fallback only)
 */
function parseTokenBasic(token: string): AuthContext {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }

  const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());

  if (!payload.tenantId && !payload.sub) {
    throw new Error('Token missing tenantId/sub claim');
  }

  logger.warn('[Auth] Using unverified token parsing - DEVELOPMENT ONLY');

  return mergeKaiMetadata({
    tenantId: payload.tenantId || payload.sub || 'unknown',
    sessionId: payload.sessionId || payload.session_id || generateSessionId(),
    userId: payload.userId || payload.sub || 'unknown',
    email: payload.email,
  }, extractKaiClaims(payload));
}

/**
 * Generate a session ID
 */
function generateSessionId(): string {
  return `session-${randomUUID()}`;
}

/**
 * Optional: Extract auth from WebSocket connection
 */
export async function extractAuthFromWebSocket(request: any): Promise<AuthContext> {
  const url = new URL(request.url || '', `http://${request.headers.host}`);
  const token = url.searchParams.get('token') || request.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    throw new Error('No token provided');
  }

  // Development mode
  if (process.env.NODE_ENV === 'development' && process.env.AUTH_DISABLED === 'true') {
    // Kai metadata (query params / headers) takes precedence; dev-tenant is only a fallback.
    const kai = extractKaiMetadata({ get: (n: string) => (url.searchParams.get(n) as string | null) ?? undefined });
    return mergeKaiMetadata({
      tenantId: url.searchParams.get('tenantId') || 'dev-tenant',
      sessionId: url.searchParams.get('sessionId') || generateSessionId(),
      userId: 'dev-user',
      email: 'dev@jiva.local',
    }, kai);
  }

  // Verify token
  const authStrategy = process.env.AUTH_STRATEGY || 'custom';
  
  switch (authStrategy) {
    case 'firebase':
      return await verifyFirebaseToken(token);
    case 'custom':
      return await verifyCustomToken(token);
    default:
      throw new Error(`Unknown auth strategy: ${authStrategy}`);
  }
}
