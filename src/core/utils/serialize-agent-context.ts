/**
 * serializeAgentContext - Produces a consistent, role-appropriate string block
 * that each agent embeds in its prompt.
 *
 * Using the same serializer for all three agents ensures the format is identical;
 * the `role` parameter governs what is included, not how it is formatted.
 *
 * Token budget guidelines (tunable):
 *   Directive:            ~500 tokens max (truncate with notice if exceeded)
 *   Conversation summary: ~300 tokens max
 *   Recent messages:      last 6 messages of all roles, ~800 tokens
 *   Validation context:   ~400 tokens max
 */

import { AgentContext } from '../types/agent-context.js';
import { Message } from '../../models/base.js';

// Rough estimate: 1 token ≈ 4 characters
const CHARS_PER_TOKEN = 4;
const DIRECTIVE_TOKEN_LIMIT = 500;
const SUMMARY_TOKEN_LIMIT = 300;
// Recent messages are no longer truncated — the underlying LLM supports a 128k
// context window and the conversation manager condenses history before this is
// called, so there is no need for an artificial per-role cap here.
const VALIDATION_CONTEXT_TOKEN_LIMIT = 400;

/**
 * Truncate text to a token-approximate character limit, appending a notice if truncated.
 */
function truncate(text: string, tokenLimit: number): string {
  const charLimit = tokenLimit * CHARS_PER_TOKEN;
  if (text.length <= charLimit) return text;
  return text.substring(0, charLimit) + '\n[...truncated due to token limit]';
}

/**
 * Serialize a single message to a compact string representation.
 */
function serializeMessage(msg: Message): string {
  const role = msg.role.toUpperCase();
  const content = typeof msg.content === 'string'
    ? msg.content
    : msg.content
      ? msg.content.map(c => c.text || '[image]').join(' ')
      : '[tool call]';
  return `[${role}]: ${content}`;
}

/**
 * Serialize AgentContext into a role-appropriate string block.
 *
 * - manager: directive + conversation (summary + recent). Omits validationContext.
 * - worker:  directive + conversation (summary + recent, incl. tool messages). Omits validationContext.
 * - client:  directive + conversation (summary + recent, incl. tool messages) + validationContext. Omits execution persona.
 */
export function serializeAgentContext(
  ctx: AgentContext,
  role: 'manager' | 'worker' | 'client'
): string {
  const sections: string[] = [];

  // ── Directive ──────────────────────────────────────────────────────────
  if (ctx.directive) {
    sections.push(
      '=== DIRECTIVE ===\n' + truncate(ctx.directive, DIRECTIVE_TOKEN_LIMIT)
    );
  }

  // ── Trusted customer context ──────────────────────────────────────────
  const trustedCustomer = ctx.trustedCustomer;
  const hasTrustedIdentity = Boolean(
    trustedCustomer && (
      trustedCustomer.phoneVerified ||
      trustedCustomer.emailVerified ||
      trustedCustomer.identityVerification?.status === 'verified' ||
      (trustedCustomer.organizationId && trustedCustomer.agentId && trustedCustomer.contactId)
    ),
  );
  if (trustedCustomer?.organizationId && trustedCustomer.agentId && !hasTrustedIdentity) {
    sections.push(
      '=== TRUSTED TENANT SESSION ===\n' +
      `Trusted organization ID: ${trustedCustomer.organizationId}\n` +
      `Trusted agent ID: ${trustedCustomer.agentId}\n` +
      (trustedCustomer.conversationId ? `Trusted conversation ID: ${trustedCustomer.conversationId}\n` : '') +
      '- These identifiers come from the signed platform session. Use them silently and never ask the customer for an organization ID or organization name.\n' +
      '- The visitor is not yet an authenticated customer. Do not use an isolated visitor contact ID to read customer records.'
    );
  }
  if (hasTrustedIdentity && trustedCustomer) {
    const trustedIdentifiers = [
      trustedCustomer.organizationId && `Trusted organization ID: ${trustedCustomer.organizationId}`,
      trustedCustomer.agentId && `Trusted agent ID: ${trustedCustomer.agentId}`,
      trustedCustomer.contactId && `Trusted contact ID: ${trustedCustomer.contactId}`,
      trustedCustomer.conversationId && `Trusted conversation ID: ${trustedCustomer.conversationId}`,
    ].filter(Boolean);
    sections.push(
      '=== TRUSTED SESSION CONTEXT ===\n' +
      (trustedIdentifiers.length > 0 ? `${trustedIdentifiers.join('\n')}\n` : '') +
      (trustedCustomer.phoneNumber ? `Verified customer phone number: ${trustedCustomer.phoneNumber}\n` : '') +
      (trustedCustomer.email ? `Verified customer email: ${trustedCustomer.email}\n` : '') +
      (trustedCustomer.identityVerification?.externalCustomerId
        ? `Verified external customer ID: ${trustedCustomer.identityVerification.externalCustomerId}\n`
        : '') +
      '- Use these trusted identifiers silently in permitted Kai MCP tool calls.\n' +
      '- Never ask the customer for an organization ID, organization name, contact ID, or phone number when it is present here.\n' +
      '- Never display or repeat the full phone number to the customer.'
    );
  }

  const verification = trustedCustomer?.identityVerification;
  if (verification?.status === 'unverified') {
    sections.push(
      '=== CUSTOMER VERIFICATION REQUIRED ===\n' +
      '- General questions and non-customer-specific support do not require verification. Continue helping normally.\n' +
      '- Before reading chat history, stored profile data, existing cases, or changing/closing a case, verify the customer through the configured client MCP tools.\n' +
      '- Ask only for the phone number or email required by the configured OTP-sending tool (the send_customer_otp contract or an equivalent such as auth_send_otp), invoke it, and tell the customer where the code was sent using only a masked destination.\n' +
      '- Never accept a typed phone number, email, name, organization name, or case number as proof of identity.\n' +
      '- Never ask for an organization ID. Do not say OTP is unavailable when an equivalent configured OTP tool exists. If no OTP tools are available, say secure verification is not available for this agent and continue with non-private support.'
    );
    const visitorVerification = trustedCustomer?.visitorVerification;
    if (visitorVerification?.openCaseAvailable) {
      const otpHint = visitorVerification.phoneNumber
        ? `Use this unverified phone only as the configured OTP-sending destination: ${visitorVerification.phoneNumber}`
        : visitorVerification.email
          ? `Use this unverified email only as the configured OTP-sending destination: ${visitorVerification.email}`
          : 'Ask for the phone number or email needed by the configured OTP-sending tool.';
      sections.push(
        '=== UNVERIFIED OPEN-CASE OFFER PENDING ===\n' +
        '- The widget has already told the visitor that an open case may exist and asked whether they want to continue.\n' +
        '- If the visitor accepts (for example, "yes" or "continue"), do not ask which case and do not reveal any case details. Explain briefly that verification is required, then call the configured OTP-sending tool (send_customer_otp or its client equivalent).\n' +
        `- ${otpHint}\n` +
        '- This destination is visitor-supplied and unverified. Never use it with customer lookup or case tools until the configured OTP-verification tool explicitly returns verified=true.\n' +
        '- If the visitor declines or asks about a different issue, continue normal non-private support and do not force the prior case context.'
      );
    }
  } else if (verification?.status === 'challenge_sent') {
    sections.push(
      '=== OTP CHALLENGE IN PROGRESS ===\n' +
      `Delivery method: ${verification.method ?? 'unknown'}\n` +
      (verification.destinationHint ? `Masked destination: ${verification.destinationHint}\n` : '') +
      '- Treat the next plausible code from the customer as verification input and call verify_customer_otp. Do not classify it as small talk.\n' +
      '- Do not resend a code unless the customer asks or verification reports that the challenge expired.\n' +
      '- Do not access customer records until verify_customer_otp explicitly returns verified=true.'
    );
  } else if (verification?.status === 'failed') {
    sections.push(
      '=== OTP VERIFICATION NOT COMPLETED ===\n' +
      '- Tell the customer the code could not be verified without exposing technical details. Let them retry the code or request a new one.\n' +
      '- Customer records and case operations remain blocked.'
    );
  } else if (verification?.status === 'verified' && verification.source === 'mcp_otp') {
    sections.push(
      '=== CUSTOMER VERIFIED BY CLIENT MCP ===\n' +
      '- The client system verified this customer. Do not ask for another OTP during this live session.\n' +
      '- If only an external customer ID is available, use the optional client get_customer_context tool to retrieve verified phone or email attributes.\n' +
      '- Resolve the verified phone or email with find_customer using the trusted organization ID before reading cases or history.\n' +
      '- If no Kai contact exists, do not report a technical failure. Continue non-private support and collect only the fields needed to create a contact if a case must be opened.\n' +
      '- After resolving the Kai contact, use its contact ID for every customer-specific read or write and preserve the same canonical case ID across channels.\n' +
      '- Check active cases with get_customer_recent_context or list_support_cases. If an active case exists, briefly offer to continue it; do not force its context onto an unrelated new question.\n' +
      '- If the customer explicitly asks to close their case, retrieve the exact case and use close_support_case with their stated reason.'
    );
  }

  if (ctx.trustedCustomer?.caseOffer?.status === 'pending') {
    const offeredCases = ctx.trustedCustomer.caseOffer.cases
      .map((item, index) => `${index + 1}. ${item.caseNumber}${item.caseId ? ` (case_id: ${item.caseId})` : ''}${item.subject ? ` — ${item.subject}` : ''}`)
      .join('\n');
    sections.push(
      '=== CASE CONTINUATION PROTOCOL ===\n' +
      `${offeredCases}\n` +
      '- An open-case continuation offer is active for this session. It takes priority over the ordinary greeting: greet the customer and ask them to choose before using prior-case details.\n' +
      '- Do not treat a case as selected until the customer explicitly confirms it.\n' +
      '- A request to explain, inspect, update, or discuss an offered case is explicit confirmation. Retrieve it immediately with get_support_case using the trusted organization ID and case_id when available.\n' +
      '- If accepted, continue helping with the selected case as the AI agent.\n' +
      '- If declined, stop referring to the offered cases and handle the new issue normally.\n' +
      '- Never claim a human joined or a transfer occurred. Human escalation is available only when the runtime directive explicitly permits it.'
    );
  }

  if (ctx.trustedCustomer?.caseOffer?.status === 'accepted') {
    const selected = ctx.trustedCustomer.caseOffer.cases.find(
      item => item.caseNumber === ctx.trustedCustomer?.caseOffer?.selectedCaseNumber,
    );
    if (selected) {
      sections.push(
        '=== ACTIVE SUPPORT CASE ===\n' +
        `${selected.caseNumber}${selected.caseId ? ` (case_id: ${selected.caseId})` : ''}${selected.subject ? ` — ${selected.subject}` : ''}\n` +
        '- The customer explicitly confirmed this case. Retrieve its details with get_support_case using the trusted organization ID before explaining or changing it.\n' +
        '- Do not claim a human joined or that a transfer occurred.'
      );
    }
  }

  // ── Conversation context ──────────────────────────────────────────────
  const convParts: string[] = [];

  if (ctx.conversation.summary) {
    convParts.push(
      '[Conversation Summary]\n' + truncate(ctx.conversation.summary, SUMMARY_TOKEN_LIMIT)
    );
  }

  if (ctx.conversation.recentMessages.length > 0) {
    const serialized = ctx.conversation.recentMessages.map(serializeMessage).join('\n');
    convParts.push(
      '[Recent Messages]\n' + serialized
    );
  }

  if (convParts.length > 0) {
    sections.push('=== CONVERSATION CONTEXT ===\n' + convParts.join('\n\n'));
  }

  // ── Validation context (client only) ──────────────────────────────────
  if (role === 'client' && ctx.persona?.validationContext) {
    sections.push(
      '=== VALIDATION CONTEXT ===\n' +
      truncate(ctx.persona.validationContext, VALIDATION_CONTEXT_TOKEN_LIMIT)
    );
  }

  return sections.join('\n\n');
}
