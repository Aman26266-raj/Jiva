import assert from 'node:assert/strict';
import test from 'node:test';
import { assembleFinalPrompt, RUNTIME_SESSION_BOUNDARY } from './prompts.js';

test('central directive is retained while tenant agent instructions are applied last', () => {
  const result = assembleFinalPrompt('TENANT CHAT PROMPT', 'JIVA CENTRAL DIRECTIVE');

  assert.ok(result.includes('JIVA CENTRAL DIRECTIVE'));
  assert.ok(result.includes(RUNTIME_SESSION_BOUNDARY));
  assert.ok(result.endsWith('TENANT CHAT PROMPT'));
  assert.ok(result.indexOf('JIVA CENTRAL DIRECTIVE') < result.indexOf('TENANT CHAT PROMPT'));
});

test('runtime boundary prevents legacy bootstrap and file references', () => {
  const result = assembleFinalPrompt('Customer behavior', 'Core behavior');

  assert.match(result, /already loaded for this session/i);
  assert.match(result, /Do not call, request, or refer to read_agent_config/i);
  assert.match(result, /knowledge-base files/i);
});
