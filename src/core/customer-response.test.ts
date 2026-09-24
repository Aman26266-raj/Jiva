import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CUSTOMER_SAFE_SYSTEM_FAILURE,
  sanitizeCustomerFacingResponse,
} from './customer-response.js';

test('keeps normal customer-facing answers', () => {
  assert.equal(
    sanitizeCustomerFacingResponse('You can book a locker from the KEUB App.'),
    'You can book a locker from the KEUB App.',
  );
});

test('replaces internal bootstrap and knowledge-base references', () => {
  const unsafe = [
    'I need to call read_agent_config first.',
    'The central directive could not be loaded.',
    'The knowledge-base file is unavailable.',
    'The MCP server returned Session not found.',
  ];

  for (const response of unsafe) {
    assert.equal(sanitizeCustomerFacingResponse(response), CUSTOMER_SAFE_SYSTEM_FAILURE);
  }
});
