/**
 * Chat identity lifecycle helpers (Kai → Jiva).
 *
 * Ownership split:
 * - Kai owns: organization_id, agent_id, contact_id
 * - Jiva owns: conversation_id, session_id
 *
 * For the Kai flow (organizationId + agentId present) Jiva derives a
 * conversation-scoped run sessionId from the conversationId itself: the first
 * request (no conversationId) gets a freshly-generated conv-{uuid} which is
 * then returned to Kai; every subsequent request that reuses that
 * conversationId runs through the SAME live session while it stays active
 * (agent + MCP sub-processes reused, no re-boot), and if the session has
 * idled out it is re-created and conversation memory is restored from GCS.
 */

import { randomUUID } from 'node:crypto';
import type { SessionIdentityOptions } from './session-manager.js';

/** Raised when a Kai chat request violates the identity contract (→ HTTP 400). */
export class KaiValidationError extends Error {}

export interface ResolvedChatIdentity {
  /** Jiva-owned run sessionId — for the Kai flow this equals the conversationId. */
  sessionId: string;
  /** Kai org/agent/conversation identity handed to the session manager. */
  identity: SessionIdentityOptions;
  /** The conversationId used for this turn (existing or freshly generated). */
  conversationId: string;
  /** True when the request supplies the Kai org/agent identity. */
  kaiFlow: boolean;
}

interface AuthLike {
  sessionId: string;
  organizationId?: string;
  agentId?: string;
  conversationId?: string;
  contactId?: string;
}

interface BodyLike {
  organizationId?: unknown;
  agentId?: unknown;
  contactId?: unknown;
  conversationId?: unknown;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Resolve the Jiva-owned run sessionId + identity for a chat request.
 *
 * Kai flow (body or auth carries organizationId + agentId):
 *   - requires contactId (else KaiValidationError);
 *   - conversationId comes from body → auth → freshly generated;
 *   - run sessionId = conversationId, so later requests for the same
 *     conversation reuse the live session.
 *
 * Legacy flow (no org/agent):
 *   - keeps today's behavior: run sessionId = the caller's sessionId,
 *     conversation identity passed through untouched.
 *
 * Kai identity in the body takes precedence over the auth context (headers/
 * JWT) so Kai can drive org/agent/contact per request without header churn.
 */
export function resolveChatIdentity(auth: AuthLike, body: BodyLike): ResolvedChatIdentity {
  const organizationId = str(body.organizationId) ?? auth.organizationId;
  const agentId = str(body.agentId) ?? auth.agentId;
  const contactId = str(body.contactId) ?? auth.contactId;
  const suppliedConversationId = str(body.conversationId) ?? auth.conversationId;

  if (!organizationId || !agentId) {
    return {
      sessionId: auth.sessionId,
      identity: {
        organizationId: auth.organizationId,
        agentId: auth.agentId,
        conversationId: auth.conversationId,
      },
      conversationId: auth.conversationId || auth.sessionId,
      kaiFlow: false,
    };
  }

  if (!contactId) {
    throw new KaiValidationError('contactId is required when organizationId and agentId are present');
  }

  const conversationId = suppliedConversationId ?? `conv-${randomUUID()}`;
  return {
    sessionId: conversationId,
    identity: { organizationId, agentId, conversationId, contactId },
    conversationId,
    kaiFlow: true,
  };
}