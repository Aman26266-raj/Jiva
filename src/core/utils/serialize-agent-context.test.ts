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

  assert.match(serialized, /TRUSTED CUSTOMER CONTEXT/);
  assert.match(serialized, /\+916201235605/);
  assert.match(serialized, /Do not ask the customer to provide or verify it again/);
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
      caseOffer: {
        status: 'pending',
        cases: [{ caseNumber: 'CASE-1001', subject: 'Account access' }],
      },
    },
    conversation: { recentMessages: [] },
  }, 'manager');

  assert.match(serialized, /CASE CONTINUATION PROTOCOL/);
  assert.match(serialized, /CASE-1001 — Account access/);
  assert.match(serialized, /takes priority over the ordinary greeting/);
  assert.match(serialized, /Do not treat a case as selected until the customer explicitly confirms/);
  assert.match(serialized, /Human escalation is available only when the runtime directive explicitly permits it/);
});
