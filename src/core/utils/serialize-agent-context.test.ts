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
