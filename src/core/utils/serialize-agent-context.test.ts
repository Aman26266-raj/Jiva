import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeAgentContext } from './serialize-agent-context.js';

test('serializes verified customer phone as trusted tool context', () => {
  const serialized = serializeAgentContext({
    workspaceDir: '/app',
    trustedCustomer: {
      phoneNumber: '+916201235605',
      phoneVerified: true,
    },
    conversation: { recentMessages: [] },
  }, 'worker');

  assert.match(serialized, /TRUSTED SESSION CONTEXT/);
  assert.match(serialized, /\+916201235605/);
  assert.match(serialized, /Never ask the customer for an organization ID/);
});

test('omits trusted customer section when none is provided', () => {
  const serialized = serializeAgentContext({
    workspaceDir: '/app',
    conversation: { recentMessages: [] },
  }, 'worker');

  assert.doesNotMatch(serialized, /TRUSTED CUSTOMER CONTEXT/);
});

test('serializes an unverified public visitor without trusting the visitor contact', () => {
  const serialized = serializeAgentContext({
    workspaceDir: '/app',
    trustedCustomer: {
      organizationId: 'org-1',
      agentId: 'agent-1',
      identityVerification: { status: 'unverified' },
    },
    conversation: { recentMessages: [] },
  }, 'manager');

  assert.match(serialized, /TRUSTED TENANT SESSION/);
  assert.match(serialized, /CUSTOMER VERIFICATION REQUIRED/);
  assert.match(serialized, /Never accept a typed phone number/);
  assert.match(serialized, /Never ask for an organization ID/);
});

test('serializes a privacy-safe open-case offer as an OTP-only verification intent', () => {
  const serialized = serializeAgentContext({
    workspaceDir: '/app',
    trustedCustomer: {
      organizationId: 'org-1',
      agentId: 'agent-1',
      identityVerification: { status: 'unverified' },
      visitorVerification: {
        openCaseAvailable: true,
        phoneNumber: '+919973090205',
      },
    },
    conversation: { recentMessages: [] },
  }, 'worker');

  assert.match(serialized, /UNVERIFIED OPEN-CASE OFFER PENDING/);
  assert.match(serialized, /do not ask which case/i);
  assert.match(serialized, /send_customer_otp destination: \+919973090205/);
  assert.match(serialized, /Never use it with customer lookup or case tools/);
});

test('serializes an in-progress OTP challenge so the next code is verified', () => {
  const serialized = serializeAgentContext({
    workspaceDir: '/app',
    trustedCustomer: {
      organizationId: 'org-1',
      agentId: 'agent-1',
      identityVerification: {
        status: 'challenge_sent',
        source: 'mcp_otp',
        method: 'phone',
        destinationHint: '+91******0205',
      },
    },
    conversation: { recentMessages: [] },
  }, 'worker');

  assert.match(serialized, /OTP CHALLENGE IN PROGRESS/);
  assert.match(serialized, /verify_customer_otp/);
  assert.match(serialized, /\+91\*\*\*\*\*\*0205/);
});

test('requires an accepted case request to continue in the OTP verification turn', () => {
  const serialized = serializeAgentContext({
    workspaceDir: '/app',
    trustedCustomer: {
      organizationId: 'org-1',
      agentId: 'agent-1',
      identityVerification: { status: 'challenge_sent', source: 'mcp_otp' },
      visitorVerification: {
        openCaseAvailable: true,
        openCaseOfferStatus: 'accepted',
        phoneNumber: '+916201235605',
      },
    },
    conversation: { recentMessages: [] },
  }, 'manager');

  assert.match(serialized, /support_verify_otp_and_get_context/);
  assert.match(serialized, /continue that request in the same turn/i);
  assert.match(serialized, /Do not stop at a generic verification confirmation/i);
});

test('serializes ticket-restored customer identifiers without a phone number', () => {
  const serialized = serializeAgentContext({
    workspaceDir: '/app',
    trustedCustomer: {
      organizationId: 'a168e4b0-0ee5-45d0-955f-aa398f20e23d',
      agentId: 'ca49ee64-bf07-4f44-8140-ff34ad6604fa',
      contactId: '91870b26-fc48-4b9b-b748-560f965ad6be',
    },
    conversation: { recentMessages: [] },
  }, 'worker');

  assert.match(serialized, /TRUSTED SESSION CONTEXT/);
  assert.match(serialized, /Trusted organization ID: a168e4b0-0ee5-45d0-955f-aa398f20e23d/);
  assert.match(serialized, /Trusted contact ID: 91870b26-fc48-4b9b-b748-560f965ad6be/);
  assert.doesNotMatch(serialized, /Verified customer phone number:/);
});

test('serializes an open-case offer without assuming customer consent', () => {
  const serialized = serializeAgentContext({
    workspaceDir: '/app',
    trustedCustomer: {
      phoneNumber: '+15551234567',
      phoneVerified: true,
      organizationId: 'a168e4b0-0ee5-45d0-955f-aa398f20e23d',
      contactId: '91870b26-fc48-4b9b-b748-560f965ad6be',
      caseOffer: {
        status: 'pending',
        cases: [{ caseId: 'cb0ceec0-b2d4-4f29-bbe0-a57d0a1dbf40', caseNumber: 'CASE-1001', subject: 'Account access' }],
      },
    },
    conversation: { recentMessages: [] },
  }, 'manager');

  assert.match(serialized, /CASE CONTINUATION PROTOCOL/);
  assert.match(serialized, /CASE-1001 \(case_id: cb0ceec0-b2d4-4f29-bbe0-a57d0a1dbf40\) — Account access/);
  assert.match(serialized, /Trusted organization ID: a168e4b0-0ee5-45d0-955f-aa398f20e23d/);
  assert.match(serialized, /case_id: cb0ceec0-b2d4-4f29-bbe0-a57d0a1dbf40/);
  assert.match(serialized, /takes priority over the ordinary greeting/);
  assert.match(serialized, /request to explain, inspect, update, or discuss an offered case is explicit confirmation/);
  assert.match(serialized, /Human escalation is available only when the runtime directive explicitly permits it/);
});
