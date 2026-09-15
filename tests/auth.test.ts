import assert from 'node:assert/strict';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import { authMiddleware } from '../src/interfaces/http/middleware/auth.js';

type MockResponse = {
  statusCode: number;
  body: unknown;
  status(code: number): MockResponse;
  json(body: unknown): MockResponse;
};

function response(): MockResponse {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function authenticate(token?: string, headers: Record<string, string> = {}) {
  const req = {
    headers: {
      ...headers,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  } as any;
  const res = response();
  let nextCalled = false;
  await authMiddleware(req, res as any, () => {
    nextCalled = true;
  });
  return { req, res, nextCalled };
}

test('custom JWT accepts a valid HS256 token and extracts identity', async () => {
  const previous = { disabled: process.env.AUTH_DISABLED, strategy: process.env.AUTH_STRATEGY, secret: process.env.JWT_SECRET };
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_STRATEGY = 'custom';
  process.env.JWT_SECRET = 'test-signing-secret-with-sufficient-length';
  try {
    const token = jwt.sign({
      sub: 'kai-web-backend',
      tenantId: 'org-1',
      sessionId: 'conversation-1',
      organization_id: 'org-1',
      agent_id: 'agent-1',
      contact_id: 'contact-1',
      conversation_id: 'conversation-1',
    }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });

    const result = await authenticate(token);
    assert.equal(result.nextCalled, true);
    assert.equal(result.res.statusCode, 200);
    assert.equal(result.req.auth.tenantId, 'org-1');
    assert.equal(result.req.auth.sessionId, 'conversation-1');
    assert.equal(result.req.auth.organizationId, 'org-1');
    assert.equal(result.req.auth.agentId, 'agent-1');
    assert.equal(result.req.auth.contactId, 'contact-1');
  } finally {
    restore(previous);
  }
});

test('custom JWT rejects a token signed with another secret', async () => {
  const previous = { disabled: process.env.AUTH_DISABLED, strategy: process.env.AUTH_STRATEGY, secret: process.env.JWT_SECRET };
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_STRATEGY = 'custom';
  process.env.JWT_SECRET = 'expected-signing-secret-with-sufficient-length';
  try {
    const token = jwt.sign({ sub: 'attacker', tenantId: 'org-1' }, 'wrong-signing-secret', {
      algorithm: 'HS256',
      expiresIn: '5m',
    });
    const result = await authenticate(token);
    assert.equal(result.nextCalled, false);
    assert.equal(result.res.statusCode, 401);
  } finally {
    restore(previous);
  }
});

test('custom JWT rejects an expired token', async () => {
  const previous = { disabled: process.env.AUTH_DISABLED, strategy: process.env.AUTH_STRATEGY, secret: process.env.JWT_SECRET };
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_STRATEGY = 'custom';
  process.env.JWT_SECRET = 'test-signing-secret-with-sufficient-length';
  try {
    const token = jwt.sign({ sub: 'kai-web-backend', tenantId: 'org-1' }, process.env.JWT_SECRET, {
      algorithm: 'HS256',
      expiresIn: -1,
    });
    const result = await authenticate(token);
    assert.equal(result.nextCalled, false);
    assert.equal(result.res.statusCode, 401);
  } finally {
    restore(previous);
  }
});

function restore(previous: { disabled?: string; strategy?: string; secret?: string }) {
  setOrDelete('AUTH_DISABLED', previous.disabled);
  setOrDelete('AUTH_STRATEGY', previous.strategy);
  setOrDelete('JWT_SECRET', previous.secret);
}

function setOrDelete(name: string, value?: string) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
