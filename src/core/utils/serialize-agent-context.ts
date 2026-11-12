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
      (trustedCustomer.organizationId && trustedCustomer.agentId && trustedCustomer.contactId)
    ),
  );
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
      '- Use these trusted identifiers silently in permitted Kai MCP tool calls.\n' +
      '- Never ask the customer for an organization ID, organization name, contact ID, or phone number when it is present here.\n' +
      '- Never display or repeat the full phone number to the customer.'
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
