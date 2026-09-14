/**
 * Conversation Result - generic, provider-neutral outcome of a completed
 * Jiva conversation, handed to the integration layer (e.g. Kai).
 *
 * Jiva owns the conversation execution and produces this result; the caller
 * decides how it maps onto its own memory layer (e.g. Kai's
 * conversation_summaries). Jiva never references Kai's schema here.
 *
 * ExternalConversationContext is the OPTIONAL trusted-context input contract:
 * the caller may supply prior interaction/case context. It is accepted,
 * passed to the summarizer as background reference, and NEVER merged into
 * Jiva's own conversation history.
 */

import { Message } from '../models/base.js';
import { ModelOrchestrator } from '../models/orchestrator.js';
import { logger } from '../utils/logger.js';

/**
 * Channel a conversation ran on.
 *
 * Jiva currently serves 'chat' only, but the set is an OPEN union so the
 * completion contract can later represent 'phone', 'web-voice' or 'email'
 * without any change to the integration boundary. Never add provider-specific
 * fields alongside it.
 */
export type Channel = 'chat' | 'phone' | 'web-voice' | 'email' | (string & {});

export interface ConversationResult {
  /** Jiva-owned conversation id (the external/source identifier for the caller). */
  conversationId: string;
  /** Channel this conversation ran on. See {@link Channel}. */
  channel: Channel;
  /** Concise summary of the interaction, when a meaningful one is available. */
  summary?: string;
  /** Short factual points distilled from the interaction. */
  keyPoints?: string[];
  /** High-level outcome, e.g. 'Resolved', 'Needs follow-up', 'Escalated'. */
  outcome?: string;
  /** Integration identity, when supplied by the caller (org/agent/contact). */
  organizationId?: string;
  agentId?: string;
  contactId?: string;
  /** Conversation start/end timestamps (ISO 8601), when known. */
  startedAt?: string;
  endedAt?: string;
  /** Number of messages in the conversation, when known. */
  messageCount?: number;
  /**
   * Caller-authored metadata bag, reserved for integrator-supplied extras.
   * Jiva itself never populates it and never writes session internals, storage
   * paths, raw model output, MCP state, or conversation history into it. Omit
   * entirely when there is nothing to attach.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Source data used to enrich a base ConversationResult into the full completion
 * record handed to the integration layer. Provider-neutral — the identity
 * shape is the caller's own (org/agent/contact), never Kai-named.
 */
export interface ConversationCompletionSource {
  identity?: { organizationId?: string; agentId?: string; contactId?: string };
  startedAt?: string;
  endedAt?: string;
  messageCount?: number;
}

/**
 * Enrich a generated ConversationResult with identity/timing/count fields so the
 * integration layer has the full completion picture. Only known generic fields
 * are copied — no unknown identity keys ever leak through.
 */
export function buildConversationCompletion(
  result: ConversationResult,
  source: ConversationCompletionSource,
): ConversationResult {
  return {
    ...result,
    ...(source.identity?.organizationId && { organizationId: source.identity.organizationId }),
    ...(source.identity?.agentId && { agentId: source.identity.agentId }),
    ...(source.identity?.contactId && { contactId: source.identity.contactId }),
    ...(source.startedAt && { startedAt: source.startedAt }),
    ...(source.endedAt && { endedAt: source.endedAt }),
    ...(source.messageCount !== undefined && { messageCount: source.messageCount }),
  };
}

export interface ExternalConversationContext {
  /** Prior interactions with this customer from other channels, if supplied. */
  previousInteractions?: unknown[];
  /** The active case Jiva is helping with, if supplied. */
  activeCase?: unknown;
}

// ─────────────────────────────────────────────────────────────
// Meaningfulness guard
// ─────────────────────────────────────────────────────────────

/** Minimum user turns before a conversation can produce a summary. */
const MIN_USER_TURNS = 2;
/** Minimum assistant turns before a conversation can produce a summary. */
const MIN_ASSISTANT_TURNS = 1;
/**
 * Minimum combined user content length. Excludes trivial exchanges such as
 * "hello" / "hi there" / "ok thanks" that are meaningless to summarize.
 */
const MIN_MEANINGFUL_CHARS = 60;

function stringContent(m: Message): string {
  return typeof m.content === 'string' ? m.content.trim() : '';
}

/**
 * Decide whether a conversation is substantial enough to summarize.
 * Guards against useless summaries of empty / single-message / greeting-only
 * conversations. Provider-neutral — no caller-specific rules here.
 */
export function shouldGenerateSummary(messages: Message[]): boolean {
  const userTurns = messages.filter(m => m.role === 'user').filter(m => stringContent(m).length > 0);
  const assistantTurns = messages.filter(m => m.role === 'assistant').filter(m => stringContent(m).length > 0);

  if (userTurns.length < MIN_USER_TURNS) return false;
  if (assistantTurns.length < MIN_ASSISTANT_TURNS) return false;

  const combinedUserChars = userTurns.reduce((n, m) => n + stringContent(m).length, 0);
  return combinedUserChars >= MIN_MEANINGFUL_CHARS;
}

// ─────────────────────────────────────────────────────────────
// External context validation
// ─────────────────────────────────────────────────────────────

/**
 * Validate + normalize the optional external-context payload.
 * Returns undefined when absent; throws when present but malformed.
 */
export function parseExternalContext(value: unknown): ExternalConversationContext | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('context must be an object');
  }
  const raw = value as Record<string, unknown>;
  const ctx: ExternalConversationContext = {};

  if (raw.previousInteractions !== undefined) {
    if (!Array.isArray(raw.previousInteractions)) {
      throw new Error('context.previousInteractions must be an array');
    }
    ctx.previousInteractions = raw.previousInteractions;
  }
  if (raw.activeCase !== undefined) {
    if (typeof raw.activeCase !== 'object' || raw.activeCase === null || Array.isArray(raw.activeCase)) {
      throw new Error('context.activeCase must be an object');
    }
    ctx.activeCase = raw.activeCase;
  }
  return ctx;
}

// ─────────────────────────────────────────────────────────────
// Summary generation
// ─────────────────────────────────────────────────────────────

/** Strip thinking blocks some reasoning models emit inline. */
function stripThinkingContent(content: string): string {
  return content
    .replace(/\x3cthink[\s\S]*?\x3c\/think>/g, '')
    .replace(/\x3cthink[\s\S]*$/g, '');
}

/** Parse the model's JSON payload into a ConversationResult. */
function parseSummaryJson(content: string): Pick<ConversationResult, 'summary' | 'keyPoints' | 'outcome'> | null {
  const cleaned = stripThinkingContent(content).trim();
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1].trim() : cleaned;

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const summary = typeof parsed?.summary === 'string' && parsed.summary.trim() ? parsed.summary.trim() : undefined;
  const outcome = typeof parsed?.outcome === 'string' && parsed.outcome.trim() ? parsed.outcome.trim() : undefined;
  const keyPoints = Array.isArray(parsed?.keyPoints)
    ? parsed.keyPoints.filter((k: unknown) => typeof k === 'string')
    : undefined;

  if (!summary && !outcome) return null;
  return { summary, keyPoints, outcome };
}

/**
 * Generate a meaningful conversation result for a completed interaction.
 *
 * Returns null (and does NOT call the model) when the conversation is too
 * trivial to summarize. The caller may also pass optional external context,
 * which is used as background reference only and never merged into Jiva's
 * conversation history.
 *
 * `channel` is threaded through (not hardcoded) so the boundary stays
 * channel-neutral; Jiva's default is 'chat'.
 */
export async function generateConversationSummary(
  conversationId: string,
  messages: Message[],
  orchestrator: ModelOrchestrator,
  externalContext?: ExternalConversationContext,
  channel: Channel = 'chat',
): Promise<ConversationResult | null> {
  if (!shouldGenerateSummary(messages)) {
    logger.debug(`[ConversationResult] Skipping summary for ${conversationId} — conversation too trivial`);
    return null;
  }

  const transcript = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => {
      const content = stringContent(m) || JSON.stringify(m.content ?? '');
      return `[${m.role.toUpperCase()}]: ${content}`;
    })
    .join('\n');

  const contextBlock = externalContext
    ? `\n\nCALLER-SUPPLIED CONTEXT (background only):\n${JSON.stringify(externalContext, null, 2)}`
    : '';

  const prompt = `You are summarizing a completed customer support conversation so a future agent on ANY channel (chat, phone, email) can continue helping this customer without re-asking.

Respond with a SINGLE JSON object and nothing else:
{
  "summary": "2-4 sentence concise summary of the issue and outcome",
  "keyPoints": ["short factual points", "..."],
  "outcome": "one-line outcome, e.g. Resolved, Needs follow-up, Escalated"
}

CONVERSATION:
${transcript}${contextBlock}`;

  try {
    const response = await orchestrator.chat({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      maxTokens: 500,
    });

    const parsed = parseSummaryJson(response.content);
    if (!parsed) {
      logger.warn(`[ConversationResult] Summary generation returned unparseable output for ${conversationId}`);
      return null;
    }

    return {
      conversationId,
      channel,
      ...(parsed.summary !== undefined && { summary: parsed.summary }),
      ...(parsed.keyPoints !== undefined && { keyPoints: parsed.keyPoints }),
      ...(parsed.outcome !== undefined && { outcome: parsed.outcome }),
    };
  } catch (error) {
    logger.error(`[ConversationResult] Summary generation failed for ${conversationId}:`, error);
    return null;
  }
}