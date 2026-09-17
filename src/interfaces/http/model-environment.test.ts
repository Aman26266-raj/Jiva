import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertRuntimeModelMatchesEnvironment,
  resolveJivaModelEnvironment,
} from './model-environment.js';

const configuredEnvironment = {
  JIVA_MODEL_PROVIDER: 'together',
  JIVA_MODEL_BASE_URL: 'https://api.together.xyz/v1/chat/completions',
  JIVA_MODEL_NAME: 'zai-org/GLM-5.3-Flash',
  JIVA_MODEL_API_KEY: 'test-secret',
};

test('resolves the required server-owned model environment', () => {
  assert.deepEqual(resolveJivaModelEnvironment(configuredEnvironment), {
    provider: 'together',
    endpoint: 'https://api.together.xyz/v1/chat/completions',
    model: 'zai-org/GLM-5.3-Flash',
    apiKey: 'test-secret',
  });
});

test('reports every missing required model environment variable', () => {
  assert.throws(
    () => resolveJivaModelEnvironment({ JIVA_MODEL_PROVIDER: 'together' }),
    /JIVA_MODEL_BASE_URL, JIVA_MODEL_NAME, JIVA_MODEL_API_KEY/,
  );
});

test('accepts matching Kai runtime and Cloud Run model settings', () => {
  const environment = resolveJivaModelEnvironment(configuredEnvironment);
  assert.doesNotThrow(() => assertRuntimeModelMatchesEnvironment({
    provider: 'Together',
    model: 'zai-org/GLM-5.3-Flash',
  }, environment));
});

test('rejects a stale runtime model before calling the provider', () => {
  const environment = resolveJivaModelEnvironment(configuredEnvironment);
  assert.throws(
    () => assertRuntimeModelMatchesEnvironment({ provider: 'together', model: 'sarvam-105b' }, environment),
    /does not match JIVA_MODEL_NAME/,
  );
});
