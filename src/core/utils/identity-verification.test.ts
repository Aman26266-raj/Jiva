import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyIdentityToolResult,
  canonicalToolName,
  customerToolBlockReason,
  isCustomerIdentityVerified,
  mergeTrustedCustomerContext,
} from './identity-verification.js';
import type { TrustedCustomerContext } from '../types/agent-context.js';

function publicContext(): TrustedCustomerContext {
  return {
    organizationId: 'org-1',
    agentId: 'agent-1',
    conversationId: 'conversation-1',
    identityVerification: { status: 'unverified' },
  };
}

test('blocks customer and case tools before verification but leaves general tools available', () => {
  const context = publicContext();
  assert.match(customerToolBlockReason(context, 'KaiMCP__get_support_case') ?? '', /verification is required/i);
  assert.match(customerToolBlockReason(context, 'KaiMCP__find_customer') ?? '', /verification is required/i);
  assert.equal(customerToolBlockReason(context, 'ClientMCP__send_customer_otp'), undefined);
  assert.equal(customerToolBlockReason(context, 'KeubMCP__db_get_locations'), undefined);
});

test('records a successfully sent client MCP OTP challenge', () => {
  const context = publicContext();
  const changed = applyIdentityToolResult(
    context,
    'ClientMCP__send_customer_otp',
    JSON.stringify({ success: true, status: 'sent', method: 'sms', destinationHint: '+91******0205' }),
  );
  assert.equal(changed, true);
  assert.equal(context.identityVerification?.status, 'challenge_sent');
  assert.equal(context.identityVerification?.method, 'phone');
  assert.equal(context.identityVerification?.destinationHint, '+91******0205');
  assert.equal(isCustomerIdentityVerified(context), false);
});

test('normalizes KEUB OTP tools into the client verification contract', () => {
  assert.equal(canonicalToolName('KeubMCP__auth_send_otp'), 'send_customer_otp');
  assert.equal(
    canonicalToolName('KeubMCP__support_verify_otp_and_get_context'),
    'verify_customer_otp',
  );

  const context = publicContext();
  const challengeChanged = applyIdentityToolResult(
    context,
    'KeubMCP__auth_send_otp',
    JSON.stringify({ success: true, message: 'OTP sent successfully to your phone' }),
  );
  assert.equal(challengeChanged, true);
  assert.equal(context.identityVerification?.status, 'challenge_sent');

  const verifiedChanged = applyIdentityToolResult(
    context,
    'KeubMCP__support_verify_otp_and_get_context',
    JSON.stringify({
      verified: true,
      user: { id: 'keub-user-1', phone: '+916201235605' },
      open_tickets: [],
    }),
  );
  assert.equal(verifiedChanged, true);
  assert.equal(context.identityVerification?.status, 'verified');
  assert.equal(context.phoneNumber, '+916201235605');
  assert.equal(context.phoneVerified, true);
  assert.equal(customerToolBlockReason(context, 'KaiMCP__list_support_cases'), undefined);
});

test('promotes only an explicit verified OTP result with usable identity claims', () => {
  const context = publicContext();
  const changed = applyIdentityToolResult(context, 'ClientMCP__verify_customer_otp', JSON.stringify({
    success: true,
    data: {
      verified: true,
      external_customer_id: 'client-user-42',
      phone_number: '919973090205',
      email: 'TESTER@TEST.COM',
      first_name: 'Ankit',
    },
  }));
  assert.equal(changed, true);
  assert.equal(context.identityVerification?.status, 'verified');
  assert.equal(context.identityVerification?.externalCustomerId, 'client-user-42');
  assert.equal(context.phoneNumber, '+919973090205');
  assert.equal(context.email, 'tester@test.com');
  assert.equal(context.firstName, 'Ankit');
  assert.equal(customerToolBlockReason(context, 'KaiMCP__get_support_case'), undefined);
});

test('does not promote a nominally successful verify result without verified=true', () => {
  const context = publicContext();
  applyIdentityToolResult(context, 'verify_customer_otp', JSON.stringify({ success: true, verified: false }));
  assert.equal(context.identityVerification?.status, 'failed');
  assert.equal(isCustomerIdentityVerified(context), false);
});

test('captures the canonical Kai contact only after customer verification', () => {
  const context = publicContext();
  applyIdentityToolResult(context, 'find_customer', JSON.stringify({ found: true, contact: { id: 'contact-unsafe' } }));
  assert.equal(context.contactId, undefined);

  context.identityVerification = { status: 'verified', source: 'mcp_otp' };
  const changed = applyIdentityToolResult(context, 'KaiMCP__find_customer', JSON.stringify({
    found: true,
    contact: { id: 'contact-1', phone_number: '+919973090205', email: 'tester@test.com' },
  }));
  assert.equal(changed, true);
  assert.equal(context.contactId, 'contact-1');
});

test('accepts verified lookup attributes from optional client customer context', () => {
  const context = publicContext();
  context.identityVerification = {
    status: 'verified',
    source: 'mcp_otp',
    externalCustomerId: 'client-user-42',
  };
  const changed = applyIdentityToolResult(context, 'ClientMCP__get_customer_context', JSON.stringify({
    success: true,
    customer: { phoneNumber: '+919973090205', email: 'tester@test.com', firstName: 'Ankit' },
  }));
  assert.equal(changed, true);
  assert.equal(context.phoneNumber, '+919973090205');
  assert.equal(context.email, 'tester@test.com');
  assert.equal(context.firstName, 'Ankit');
});

test('does not downgrade a live verified identity on an unverified reconnect', () => {
  const verified: TrustedCustomerContext = {
    organizationId: 'org-1',
    agentId: 'agent-1',
    contactId: 'contact-1',
    phoneNumber: '+919973090205',
    phoneVerified: true,
    identityVerification: { status: 'verified', source: 'mcp_otp' },
  };
  const merged = mergeTrustedCustomerContext(verified, {
    organizationId: 'org-1',
    agentId: 'agent-1',
    conversationId: 'conversation-1',
    identityVerification: { status: 'unverified' },
  });
  assert.equal(merged.identityVerification?.status, 'verified');
  assert.equal(merged.contactId, 'contact-1');
  assert.equal(merged.conversationId, 'conversation-1');
});
