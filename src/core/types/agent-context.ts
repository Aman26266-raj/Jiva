/**
 * AgentContext - Shared context payload for all three agents (Manager, Worker, Client)
 *
 * Produced once per turn by DualAgent.buildAgentContext() and passed consistently
 * to Manager plan creation, Worker execution, and Client validation.
 */

import { Message } from '../../models/base.js';

export interface TrustedCustomerContext {
  phoneNumber: string;
  phoneVerified: true;
  caseOffer?: {
    status: 'pending' | 'accepted' | 'declined';
    selectedCaseNumber?: string;
    cases: Array<{
      caseNumber: string;
      subject?: string | null;
    }>;
  };
}

export interface AgentContext {
  /** Absolute path to the current workspace directory */
  workspaceDir: string;

  /** Raw directive prompt block, freshly loaded each turn */
  directive?: string;

  /** Verified customer data supplied by the trusted platform gateway. */
  trustedCustomer?: TrustedCustomerContext;

  /** Bounded conversation history */
  conversation: {
    /** Optional condensed summary (from ConversationManager) */
    summary?: string;
    /** Bounded list of recent messages (user + assistant + tool roles) */
    recentMessages: Message[];
  };

  /** Persona context, split by purpose */
  persona?: {
    /** Active persona name */
    name?: string;
    /** For Manager/Worker: full persona block + <available_skills> */
    systemPromptAddition?: string;
    /** For Client: skills metadata + constraints only (no execution directives) */
    validationContext?: string;
  };
}
