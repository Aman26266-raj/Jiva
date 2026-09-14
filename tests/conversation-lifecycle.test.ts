/**
 * Kai → Jiva chat identity + conversation-result lifecycle tests.
 *
 * Covers:
 *  1. first message creates conversationId
 *  2. subsequent message reuses conversationId
 *  3. sessionId remains conversationId
 *  4. conversation restores from GCS (storage layer)
 *  5. summary is not generated for trivial messages
 *  6. completed conversation exposes summary
 *  7. external context accepted without changing Jiva's own history
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveChatIdentity, KaiValidationError } from '../src/interfaces/http/chat-identity.js';
import {
  shouldGenerateSummary,
  generateConversationSummary,
  parseExternalContext,
  buildConversationCompletion,
} from '../src/core/conversation-result.js';
import type { ModelOrchestrator } from '../src/models/orchestrator.js';
import type { Message } from '../src/models/base.js';
import { StorageProvider } from '../src/storage/provider.js';
import type { StorageContext, SavedConversation, ConversationMetadata, LogEntry, JivaState } from '../src/storage/types.js';
import { SessionManager } from '../src/interfaces/http/session-manager.js';
import type { ConversationIntegration, SessionIdentityOptions } from '../src/interfaces/http/session-manager.js';

// ─── helpers ────────────────────────────────────────────────────────────────

const AUTH = {
  sessionId: 'session-xyz',
  organizationId: 'org-1',
  agentId: 'agent-1',
  contactId: 'contact-1',
};

function stubOrchestrator(content: string): ModelOrchestrator {
  return {
    chat: async () => ({ content }),
  } as unknown as ModelOrchestrator;
}

/**
 * In-memory storage provider that mirrors the GCS provider's scoping semantics
 * (storageBasePath ?? tenantId as the storage root) so tests validate the exact
 * Kai contract — conversation restore by conversationId, cross-org isolation —
 * without requiring a live GCS bucket.
 */
class MockScopedStorageProvider extends StorageProvider {
  private store = new Map<string, SavedConversation>();
  private parent: MockScopedStorageProvider;

  constructor(parent?: MockScopedStorageProvider) {
    super({});
    this.parent = parent ?? this;
  }

  async initialize(): Promise<void> {}

  override createSessionScoped(context: StorageContext): MockScopedStorageProvider {
    const scoped = new MockScopedStorageProvider(this.parent);
    scoped.setContext(context);
    return scoped;
  }

  private root(): string {
    const ctx = this.requireContext();
    return ctx.storageBasePath ?? ctx.tenantId;
  }

  private key(id: string): string {
    return `${this.root()}/conversations/${id}/conversation.json`;
  }

  async saveConversation(conversation: SavedConversation): Promise<string> {
    this.parent.store.set(this.key(conversation.metadata.id), conversation);
    return conversation.metadata.id;
  }

  async loadConversation(id: string): Promise<SavedConversation | null> {
    return this.parent.store.get(this.key(id)) ?? null;
  }

  async listConversations(): Promise<ConversationMetadata[]> {
    const prefix = `${this.root()}/conversations/`;
    return [...this.parent.store.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([, v]) => v.metadata);
  }

  async deleteConversation(id: string): Promise<void> {
    this.parent.store.delete(this.key(id));
  }

  async getConfig<T>(key: string): Promise<T | undefined> { return undefined; }
  async setConfig<T>(key: string, value: T): Promise<void> {}
  async getAllConfig(): Promise<Record<string, any>> { return {}; }
  async loadDirective(workspacePath: string): Promise<string | undefined> { return undefined; }
  async saveDirective(workspacePath: string, content: string): Promise<void> {}
  async appendToLog(key: string, content: string): Promise<void> {}
  async flushLogs(): Promise<void> {}
  async exportState(): Promise<JivaState> {
    throw new Error('not implemented in test mock');
  }
  async importState(state: JivaState): Promise<void> {}
}

// ─── 1. first message creates conversationId ────────────────────────────────

test('first Kai message generates a conv-{uuid} conversationId', () => {
  const body = {
    organizationId: 'org-1',
    agentId: 'agent-1',
    contactId: 'contact-1',
    message: 'Hello, I need help',
    runtimeConfigUri: 'gs://bucket/runtime.json',
  };
  const resolved = resolveChatIdentity(AUTH, body);

  assert.equal(resolved.kaiFlow, true);
  assert.match(resolved.conversationId, /^conv-[0-9a-f-]+$/);
});

// ─── 2. subsequent message reuses conversationId ───────────────────────────

test('subsequent Kai message reuses the supplied conversationId', () => {
  const body = {
    organizationId: 'org-1',
    agentId: 'agent-1',
    contactId: 'contact-1',
    conversationId: 'conv-abc123',
    message: 'Follow up question',
  };
  const resolved = resolveChatIdentity(AUTH, body);

  assert.equal(resolved.conversationId, 'conv-abc123');
});

test('Kai identity preserves the originating channel', () => {
  const resolved = resolveChatIdentity(AUTH, {
    organizationId: 'org-1', agentId: 'agent-1', contactId: 'contact-1',
    conversationId: 'conv-abc123', channel: 'whatsapp', message: 'hello',
  });
  assert.equal(resolved.identity.channel, 'whatsapp');
});

// ─── 3. sessionId remains conversationId ───────────────────────────────────

test('run sessionId equals the conversationId in the Kai flow', () => {
  const first = resolveChatIdentity(AUTH, {
    organizationId: 'org-1',
    agentId: 'agent-1',
    contactId: 'contact-1',
    message: 'first',
  });
  assert.equal(first.sessionId, first.conversationId);

  const second = resolveChatIdentity(AUTH, {
    organizationId: 'org-1',
    agentId: 'agent-1',
    contactId: 'contact-1',
    conversationId: 'conv-abc123',
    message: 'second',
  });
  assert.equal(second.sessionId, 'conv-abc123');
});

test('Kai flow requires contactId when org/agent are present', () => {
  assert.throws(
    () => resolveChatIdentity(
      { sessionId: 'session-xyz', organizationId: 'org-1', agentId: 'agent-1' },
      { organizationId: 'org-1', agentId: 'agent-1', message: 'hi' },
    ),
    KaiValidationError,
  );
});

// ─── 4. conversation restores from GCS (storage layer) ─────────────────────

test('conversation persists under org/agent base and restores via conversationId', async () => {
  const parent = new MockScopedStorageProvider();

  // Simulate a Kai session's scoped provider (org/agent storage root).
  const scoped = parent.createSessionScoped({
    tenantId: 't-1',
    sessionId: 'conv-abc123',
    storageBasePath: 'organizations/org-1/agents/agent-1',
  });

  const conversation: SavedConversation = {
    metadata: {
      id: 'conv-abc123',
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      messageCount: 2,
    },
    messages: [
      { role: 'user', content: 'I need help' },
      { role: 'assistant', content: 'Sure, tell me more' },
    ],
  };
  await scoped.saveConversation(conversation);

  // A later session (different session object, same conversationId) restores it.
  const restoredProvider = parent.createSessionScoped({
    tenantId: 't-1',
    sessionId: 'conv-abc123',
    storageBasePath: 'organizations/org-1/agents/agent-1',
  });
  const restored = await restoredProvider.loadConversation('conv-abc123');
  assert.ok(restored);
  assert.equal(restored.metadata.id, 'conv-abc123');
  assert.equal(restored.messages.length, 2);

  // Cross-org/agent access is impossible — different storage root.
  const otherOrg = parent.createSessionScoped({
    tenantId: 't-1',
    sessionId: 'conv-abc123',
    storageBasePath: 'organizations/org-2/agents/agent-1',
  });
  assert.equal(await otherOrg.loadConversation('conv-abc123'), null);
});

// ─── 5. summary is not generated for trivial messages ──────────────────────

test('summary guard rejects empty / single-message / greeting-only conversations', () => {
  assert.equal(shouldGenerateSummary([]), false);
  assert.equal(shouldGenerateSummary([{ role: 'user', content: 'hello' }]), false);
  assert.equal(
    shouldGenerateSummary([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'Hi, how can I help?' },
    ]),
    false,
  );
  assert.equal(
    shouldGenerateSummary([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'Hi!' },
      { role: 'user', content: 'ok thanks' },
    ]),
    false,
  );
});

test('summary generation returns null without calling the model for trivial conversations', async () => {
  let called = false;
  const orchestrator = {
    chat: async () => {
      called = true;
      return { content: 'unused' };
    },
  } as unknown as ModelOrchestrator;

  const result = await generateConversationSummary('conv-abc', [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'Hi!' },
  ], orchestrator);

  assert.equal(result, null);
  assert.equal(called, false);
});

// ─── 6. completed conversation exposes summary ─────────────────────────────

test('meaningful conversation produces a summary + keyPoints + outcome', async () => {
  const messages = [
    { role: 'user', content: 'I was charged twice for my subscription this month' },
    { role: 'assistant', content: 'I can help with that. Let me look into your account.' },
    { role: 'user', content: 'The second charge happened on the 15th' },
    { role: 'assistant', content: 'I found it. I have issued a refund for the duplicate charge.' },
  ];

  const orchestrator = stubOrchestrator(
    '```json\n{"summary":"Customer reported a duplicate subscription charge; refund issued.","keyPoints":["Duplicate charge on the 15th","Refund issued"],"outcome":"Resolved"}\n```',
  );

  const result = await generateConversationSummary('conv-abc123', messages, orchestrator);
  assert.ok(result);
  assert.equal(result.conversationId, 'conv-abc123');
  assert.equal(result.channel, 'chat');
  assert.match(result.summary!, /duplicate subscription charge/i);
  assert.equal(result.keyPoints!.length, 2);
  assert.equal(result.outcome, 'Resolved');
});

// ─── 7. external context is accepted without changing Jiva history ─────────

test('external context is passed to the summarizer and never merged into history', async () => {
  const messages = [
    { role: 'user', content: 'I was charged twice for my subscription this month' },
    { role: 'assistant', content: 'Let me look into that for you.' },
    { role: 'user', content: 'The duplicate charge happened on the 15th' },
    { role: 'assistant', content: 'I have issued a refund.' },
  ];
  const original = JSON.stringify(messages);

  const externalContext = {
    previousInteractions: [{ channel: 'phone', summary: 'Called about billing' }],
    activeCase: { id: 'case-9', priority: 'high' },
  };

  // The prompt sent to the model must contain the external context.
  let sentPrompt = '';
  const orchestrator = {
    chat: async (options: { messages: { content: string }[] }) => {
      sentPrompt = options.messages[0].content;
      return { content: '```json\n{"summary":"Billing issue resolved.","keyPoints":[],"outcome":"Resolved"}\n```' };
    },
  } as unknown as ModelOrchestrator;

  const result = await generateConversationSummary('conv-abc123', messages, orchestrator, externalContext);
  assert.ok(result);
  assert.match(sentPrompt, /phone/);
  assert.match(sentPrompt, /case-9/);

  // Jiva's own history is untouched.
  assert.equal(JSON.stringify(messages), original);
});

test('parseExternalContext validates shape and rejects malformed payloads', () => {
  assert.equal(parseExternalContext(undefined), undefined);
  assert.equal(parseExternalContext(null), undefined);
  assert.deepEqual(parseExternalContext({ previousInteractions: [], activeCase: {} }), {
    previousInteractions: [],
    activeCase: {},
  });
  assert.throws(() => parseExternalContext('nope'));
  assert.throws(() => parseExternalContext({ previousInteractions: 'bad' }));
  assert.throws(() => parseExternalContext({ activeCase: [1, 2] }));
});

// ─── 8. conversation-completion integration hook ────────────────────────────

const MEANINGFUL_HISTORY: Message[] = [
  { role: 'user', content: 'I was charged twice for my subscription this month' },
  { role: 'assistant', content: 'I can help with that. Let me look into your account.' },
  { role: 'user', content: 'The second charge happened on the 15th' },
  { role: 'assistant', content: 'I found it. I have issued a refund for the duplicate charge.' },
];

const TRIVIAL_HISTORY: Message[] = [
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'Hi, how can I help?' },
  { role: 'user', content: 'ok thanks' },
];

const IDENTITY: SessionIdentityOptions = {
  organizationId: 'org-1',
  agentId: 'agent-1',
  contactId: 'contact-1',
  conversationId: 'conv-abc123',
};

/**
 * Build a SessionManager and inject a stub session directly into its private
 * sessions map, so finalizeConversation's real code path (guard, generation,
 * persistence, integration hook) can be exercised without booting a full agent.
 */
function managerWithSession(opts: {
  history: Message[];
  identity?: SessionIdentityOptions;
  integration?: ConversationIntegration;
}): { manager: SessionManager; scoped: MockScopedStorageProvider; received: ConversationResult[] } {
  const parent = new MockScopedStorageProvider();
  const scoped = parent.createSessionScoped({
    tenantId: 't-1',
    sessionId: opts.identity?.conversationId ?? 'conv-abc123',
    storageBasePath: 'organizations/org-1/agents/agent-1',
  });

  const received: ConversationResult[] = [];
  const manager = new SessionManager({
    storageProvider: parent,
    maxConcurrentSessions: 10,
    idleTimeoutMs: 60000,
    integration: opts.integration,
  });

  const stub = {
    identity: opts.identity,
    info: { createdAt: new Date('2026-01-01T00:00:00Z') },
    orchestrator: stubOrchestrator(
      '```json\n{"summary":"Customer reported a duplicate subscription charge; refund issued.","keyPoints":["Duplicate charge on the 15th","Refund issued"],"outcome":"Resolved"}\n```',
    ),
    agent: { getConversationHistory: () => opts.history },
    storageProvider: scoped,
  };
  (manager as unknown as { sessions: Map<string, unknown> }).sessions.set('t-1:conv-abc123', stub);

  return { manager, scoped, received };
}

test('integration handler is invoked with the enriched completion for a meaningful conversation', async () => {
  const received: ConversationResult[] = [];
  const { manager } = managerWithSession({
    history: MEANINGFUL_HISTORY,
    identity: IDENTITY,
    integration: { onConversationCompleted: async (r) => received.push(r) },
  });

  const result = await manager.finalizeConversation('t-1', 'conv-abc123');

  assert.ok(result);
  assert.equal(received.length, 1);
  const completion = received[0];
  assert.equal(completion.conversationId, 'conv-abc123');
  assert.equal(completion.channel, 'chat');
  assert.match(completion.summary!, /duplicate subscription charge/i);
  assert.equal(completion.organizationId, 'org-1');
  assert.equal(completion.agentId, 'agent-1');
  assert.equal(completion.contactId, 'contact-1');
  assert.equal(completion.startedAt, '2026-01-01T00:00:00.000Z');
  assert.ok(completion.endedAt);
  assert.equal(completion.messageCount, MEANINGFUL_HISTORY.length);
});

test('integration handler is NOT invoked for a trivial conversation', async () => {
  let calls = 0;
  const { manager } = managerWithSession({
    history: TRIVIAL_HISTORY,
    identity: IDENTITY,
    integration: { onConversationCompleted: async () => { calls += 1; } },
  });

  const result = await manager.finalizeConversation('t-1', 'conv-abc123');

  assert.equal(result, null);
  assert.equal(calls, 0);
});

test('no integration handler configured: legacy flow still returns a result and persists the summary', async () => {
  const { manager, scoped } = managerWithSession({ history: MEANINGFUL_HISTORY, identity: IDENTITY });

  const result = await manager.finalizeConversation('t-1', 'conv-abc123');

  assert.ok(result);
  assert.equal(result.conversationId, 'conv-abc123');
  const persisted = await scoped.loadConversation('conv-abc123');
  assert.ok(persisted);
  assert.match(persisted.metadata.summary!, /duplicate subscription charge/i);
});

test('handler failure does not reject finalizeConversation and the result is still returned', async () => {
  const { manager } = managerWithSession({
    history: MEANINGFUL_HISTORY,
    identity: IDENTITY,
    integration: { onConversationCompleted: async () => { throw new Error('Kai persistence down'); } },
  });

  const result = await manager.finalizeConversation('t-1', 'conv-abc123');

  assert.ok(result);
  assert.equal(result.conversationId, 'conv-abc123');
});

test('synchronous handler throw is also tolerated and the result is still returned', async () => {
  const { manager } = managerWithSession({
    history: MEANINGFUL_HISTORY,
    identity: IDENTITY,
    integration: { onConversationCompleted: () => { throw new Error('sync boom'); } },
  });

  const result = await manager.finalizeConversation('t-1', 'conv-abc123');

  assert.ok(result);
  assert.equal(result.summary, 'Customer reported a duplicate subscription charge; refund issued.');
});

test('buildConversationCompletion is provider-neutral and copies only known generic fields', () => {
  const completion = buildConversationCompletion(
    { conversationId: 'conv-abc123', channel: 'chat', summary: 's', keyPoints: [], outcome: 'Resolved' },
    {
      identity: { organizationId: 'org-1', agentId: 'agent-1', contactId: 'contact-1', conversationId: 'ignored' } as unknown as SessionIdentityOptions,
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:01:00.000Z',
      messageCount: 4,
    },
  );

  assert.deepEqual(Object.keys(completion).sort(), [
    'agentId',
    'channel',
    'contactId',
    'conversationId',
    'endedAt',
    'keyPoints',
    'messageCount',
    'organizationId',
    'outcome',
    'startedAt',
    'summary',
  ]);
  // No Kai-named fields ever leak into the contract.
  assert.equal(JSON.stringify(completion).match(/kai/i), null);
});

test('legacy session (no identity) completion carries no org/agent/contact fields', () => {
  const completion = buildConversationCompletion(
    { conversationId: 'conv-legacy', channel: 'chat', summary: 's', outcome: 'Resolved' },
    { startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:01:00.000Z', messageCount: 4 },
  );

  assert.equal(completion.organizationId, undefined);
  assert.equal(completion.agentId, undefined);
  assert.equal(completion.contactId, undefined);
});

test('integration hook is additive: summary persisted AND handler receives the completion', async () => {
  const received: ConversationResult[] = [];
  const { manager, scoped } = managerWithSession({
    history: MEANINGFUL_HISTORY,
    identity: IDENTITY,
    integration: { onConversationCompleted: async (r) => received.push(r) },
  });

  const result = await manager.finalizeConversation('t-1', 'conv-abc123');

  assert.ok(result);
  assert.equal(received.length, 1);
  const persisted = await scoped.loadConversation('conv-abc123');
  assert.ok(persisted);
  assert.match(persisted.metadata.summary!, /duplicate subscription charge/i);
});

// ─── hardening: non-blocking, history isolation, persistence, neutrality ─────

test('integration does not modify conversation history or the returned result', async () => {
  const history = [...MEANINGFUL_HISTORY];
  const snapshot = JSON.stringify(history);
  const { manager } = managerWithSession({
    history,
    identity: IDENTITY,
    integration: {
      onConversationCompleted: (r) => {
        // A hostile/buggy handler tries to mutate what it was handed.
        r.summary = 'hijacked';
        r.metadata = { hack: true };
      },
    },
  });

  const result = await manager.finalizeConversation('t-1', 'conv-abc123');

  assert.ok(result);
  // Jiva's own conversation history is untouched.
  assert.equal(JSON.stringify(history), snapshot);
  // The handler received a defensive copy, so the persisted/returned record is intact.
  assert.equal(result.summary, 'Customer reported a duplicate subscription charge; refund issued.');
  assert.equal(result.metadata, undefined);
});

test('Jiva summary is persisted even when the integration fails', async () => {
  const { manager, scoped } = managerWithSession({
    history: MEANINGFUL_HISTORY,
    identity: IDENTITY,
    integration: { onConversationCompleted: async () => { throw new Error('Kai down'); } },
  });

  const result = await manager.finalizeConversation('t-1', 'conv-abc123');

  assert.ok(result);
  const persisted = await scoped.loadConversation('conv-abc123');
  assert.ok(persisted);
  assert.match(persisted.metadata.summary!, /duplicate subscription charge/i);
});

test('finalizeConversation does not wait for a slow integration handler', async () => {
  let settled = false;
  let release!: () => void;
  const slow = new Promise<void>((resolve) => { release = resolve; });
  const { manager } = managerWithSession({
    history: MEANINGFUL_HISTORY,
    identity: IDENTITY,
    integration: { onConversationCompleted: () => slow.then(() => { settled = true; }) },
  });

  const startedAt = Date.now();
  const result = await manager.finalizeConversation('t-1', 'conv-abc123');
  const elapsed = Date.now() - startedAt;

  assert.ok(result);
  assert.equal(settled, false, 'handler promise must still be pending when finalizeConversation returns');
  assert.ok(elapsed < 2000, `finalizeConversation awaited the slow handler (took ${elapsed}ms)`);

  release();
  await slow;
  assert.equal(settled, true);
});

test('legacy session without identity still finalizes and returns a result', async () => {
  const { manager } = managerWithSession({ history: MEANINGFUL_HISTORY });

  const result = await manager.finalizeConversation('t-1', 'conv-abc123');

  assert.ok(result);
  assert.equal(result.conversationId, 'conv-abc123');
  assert.equal(result.organizationId, undefined);
  assert.equal(result.agentId, undefined);
  assert.equal(result.contactId, undefined);
});

test('channel is a neutral open contract, not structurally chat-only', async () => {
  const summary = '```json\n{"summary":"S","keyPoints":[],"outcome":"Resolved"}\n```';
  const orc = () => stubOrchestrator(summary);

  const chat = await generateConversationSummary('conv-chat', MEANINGFUL_HISTORY, orc());
  assert.equal(chat?.channel, 'chat');

  const email = await generateConversationSummary('conv-email', MEANINGFUL_HISTORY, orc(), undefined, 'email');
  assert.equal(email?.channel, 'email');

  const voice = await generateConversationSummary('conv-voice', MEANINGFUL_HISTORY, orc(), undefined, 'web-voice');
  assert.equal(voice?.channel, 'web-voice');
});
