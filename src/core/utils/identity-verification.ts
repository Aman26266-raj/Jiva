import type { TrustedCustomerContext } from '../types/agent-context.js';

const RESTRICTED_CUSTOMER_TOOLS = new Set([
  'find_customer',
  'get_customer_recent_context',
  'get_last_call_for_customer',
  'list_support_cases',
  'get_support_case',
  'create_support_case',
  'add_case_activity',
  'resolve_support_case',
  'close_support_case',
  'reopen_support_case',
  'create_contact',
  'update_contact',
  'get_customer_context',
]);

export function canonicalToolName(toolName: string): string {
  const parts = toolName.split('__');
  const name = (parts[parts.length - 1] || toolName).trim().toLowerCase();
  // Client MCPs may expose their existing OTP operations under product-specific
  // names. Normalize only aliases whose response contract is strong enough for
  // Jiva's verification state machine; the response still has to explicitly
  // confirm success/verification before any trusted state is changed.
  if (name === 'auth_send_otp') return 'send_customer_otp';
  if (name === 'support_verify_otp_and_get_context') return 'verify_customer_otp';
  return name;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parsePayload(result: unknown): Record<string, unknown> | null {
  const objectResult = asRecord(result);
  if (objectResult && typeof objectResult.text === 'string') return parsePayload(objectResult.text);
  if (objectResult) return objectResult;
  if (typeof result !== 'string') return null;

  const value = result.trim();
  if (!value || value.startsWith('Error:')) return null;
  const candidates = [
    value,
    value.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, ''),
  ];
  const firstBrace = value.indexOf('{');
  const lastBrace = value.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(value.slice(firstBrace, lastBrace + 1));

  for (const candidate of candidates) {
    try {
      const record = asRecord(JSON.parse(candidate));
      if (record) return record;
    } catch {
      // Try the next safe representation.
    }
  }
  return null;
}

function nestedRecords(payload: Record<string, unknown>): Record<string, unknown>[] {
  const records = [payload];
  for (const key of ['data', 'result', 'payload', 'identity', 'customer', 'user']) {
    const nested = asRecord(payload[key]);
    if (nested) records.push(nested);
  }
  for (const record of [...records]) {
    for (const key of ['identity', 'customer', 'user']) {
      const nested = asRecord(record[key]);
      if (nested && !records.includes(nested)) records.push(nested);
    }
  }
  return records;
}

function firstString(records: Record<string, unknown>[], keys: string[], maxLength = 320): string | undefined {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value.trim().slice(0, maxLength);
    }
  }
  return undefined;
}

function firstBoolean(records: Record<string, unknown>[], keys: string[]): boolean | undefined {
  for (const record of records) {
    for (const key of keys) {
      if (typeof record[key] === 'boolean') return record[key] as boolean;
    }
  }
  return undefined;
}

function normalizePhone(value?: string): string | undefined {
  if (!value) return undefined;
  const compact = value.replace(/[\s().-]/g, '');
  const normalized = compact.startsWith('+') ? compact : `+${compact}`;
  return /^\+[1-9]\d{7,14}$/.test(normalized) ? normalized : undefined;
}

function validEmail(value?: string): string | undefined {
  if (!value || value.length > 254) return undefined;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value.toLowerCase() : undefined;
}

export function isCustomerIdentityVerified(context?: TrustedCustomerContext): boolean {
  return context?.phoneVerified === true
    || context?.emailVerified === true
    || context?.identityVerification?.status === 'verified';
}

export function mergeTrustedCustomerContext(
  current: TrustedCustomerContext | undefined,
  incoming: TrustedCustomerContext,
): TrustedCustomerContext {
  if (!current) return { ...incoming };
  if (isCustomerIdentityVerified(current) && !isCustomerIdentityVerified(incoming)) {
    return {
      ...current,
      organizationId: incoming.organizationId ?? current.organizationId,
      agentId: incoming.agentId ?? current.agentId,
      conversationId: incoming.conversationId ?? current.conversationId,
    };
  }
  return { ...current, ...incoming };
}

export function customerToolBlockReason(
  context: TrustedCustomerContext | undefined,
  toolName: string,
): string | undefined {
  const name = canonicalToolName(toolName);
  if (!RESTRICTED_CUSTOMER_TOOLS.has(name) || isCustomerIdentityVerified(context)) return undefined;
  return 'Secure customer verification is required before reading or changing customer records, chat history, or support cases. Use the configured send_customer_otp and verify_customer_otp tools first. If those tools are unavailable, explain that secure verification is not available for this agent; do not ask for an organization ID.';
}

/** Consume the standardized client MCP OTP contract and Kai customer lookup result. */
export function applyIdentityToolResult(
  context: TrustedCustomerContext,
  toolName: string,
  result: unknown,
): boolean {
  const name = canonicalToolName(toolName);
  if (
    name !== 'send_customer_otp'
    && name !== 'verify_customer_otp'
    && name !== 'get_customer_context'
    && name !== 'find_customer'
  ) return false;
  const payload = parsePayload(result);
  if (!payload) return false;
  const records = nestedRecords(payload);

  if (name === 'send_customer_otp') {
    const status = firstString(records, ['status'])?.toLowerCase();
    const sent = firstBoolean(records, ['success', 'sent', 'otpSent', 'otp_sent']) === true
      || status === 'sent'
      || status === 'challenge_sent'
      || status === 'pending';
    if (!sent) return false;
    const rawMethod = firstString(records, ['method', 'channel'])?.toLowerCase();
    const method = rawMethod === 'phone' || rawMethod === 'sms'
      ? 'phone'
      : rawMethod === 'email'
        ? 'email'
        : 'unknown';
    context.identityVerification = {
      status: 'challenge_sent',
      source: 'mcp_otp',
      method,
      destinationHint: firstString(records, ['destinationHint', 'destination_hint', 'maskedDestination', 'masked_destination'], 120),
    };
    return true;
  }

  if (name === 'verify_customer_otp') {
    if (firstBoolean(records, ['verified', 'isVerified', 'is_verified']) !== true) {
      context.identityVerification = {
        ...(context.identityVerification ?? {}),
        status: 'failed',
        source: 'mcp_otp',
      };
      return true;
    }

    const phoneNumber = normalizePhone(firstString(records, ['phoneNumber', 'phone_number', 'phone']));
    const email = validEmail(firstString(records, ['email', 'emailAddress', 'email_address']));
    const externalCustomerId = firstString(records, [
      'externalCustomerId', 'external_customer_id', 'customerId', 'customer_id', 'userId', 'user_id',
    ], 200);
    if (!phoneNumber && !email && !externalCustomerId) return false;

    context.identityVerification = {
      status: 'verified',
      source: 'mcp_otp',
      method: phoneNumber ? 'phone' : email ? 'email' : 'unknown',
      externalCustomerId,
      verifiedAt: new Date().toISOString(),
    };
    if (phoneNumber) {
      context.phoneNumber = phoneNumber;
      context.phoneVerified = true;
    }
    if (email) {
      context.email = email;
      context.emailVerified = true;
    }
    context.firstName = firstString(records, ['firstName', 'first_name'], 100);
    context.lastName = firstString(records, ['lastName', 'last_name'], 100);
    return true;
  }

  if (!isCustomerIdentityVerified(context)) return false;
  if (name === 'get_customer_context') {
    const phoneNumber = normalizePhone(firstString(records, ['phoneNumber', 'phone_number', 'phone']));
    const email = validEmail(firstString(records, ['email', 'emailAddress', 'email_address']));
    if (!phoneNumber && !email) return false;
    if (phoneNumber) {
      context.phoneNumber = phoneNumber;
      context.phoneVerified = true;
    }
    if (email) {
      context.email = email;
      context.emailVerified = true;
    }
    context.firstName = firstString(records, ['firstName', 'first_name'], 100) ?? context.firstName;
    context.lastName = firstString(records, ['lastName', 'last_name'], 100) ?? context.lastName;
    return true;
  }

  const contactContainer = records.find(record => {
    const contact = asRecord(record.contact);
    return contact && typeof contact.id === 'string';
  });
  const contact = contactContainer ? asRecord(contactContainer.contact) : null;
  if (firstBoolean(records, ['found']) !== true || !contact || typeof contact.id !== 'string' || !contact.id.trim()) return false;
  context.contactId = contact.id.trim().slice(0, 200);
  const contactPhone = normalizePhone(typeof contact.phone_number === 'string' ? contact.phone_number : undefined);
  const contactEmail = validEmail(typeof contact.email === 'string' ? contact.email : undefined);
  if (contactPhone) {
    context.phoneNumber = contactPhone;
    context.phoneVerified = true;
  }
  if (contactEmail) {
    context.email = contactEmail;
    context.emailVerified = true;
  }
  return true;
}
