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
