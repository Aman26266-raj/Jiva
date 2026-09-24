import test from 'node:test';
import assert from 'node:assert/strict';
import { Tool } from '../models/base.js';
import { resolveCanonicalToolName } from './worker-agent.js';

const tools: Tool[] = [
  {
    name: 'KeubMCP__db_get_locations',
    description: 'Get active locations',
    parameters: { type: 'object', properties: {} },
  },
];

test('resolveCanonicalToolName preserves the registered casing', () => {
  assert.equal(
    resolveCanonicalToolName('keubMCP__db_get_locations', tools),
    'KeubMCP__db_get_locations',
  );
});

test('resolveCanonicalToolName strips a functions namespace prefix', () => {
  assert.equal(
    resolveCanonicalToolName('functionsKeubMCP__db_get_locations', tools),
    'KeubMCP__db_get_locations',
  );
});

test('resolveCanonicalToolName rejects unknown tools', () => {
  assert.equal(resolveCanonicalToolName('KeubMCP__missing', tools), null);
});
