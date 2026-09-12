/**
 * Session Manager - Lifecycle management for agent sessions
 *
 * Responsibilities:
 * - Create/destroy agent instances per session
 * - Track active sessions and enforce limits
 * - Handle idle timeouts
 * - Per-session MCP server initialization
 * - State persistence on shutdown
 *
 * When JIVA_CODE_MODE=true, sessions use CodeAgent (single-loop, in-process tools, LSP).
 * Otherwise the default DualAgent (Manager→Worker→Client) is used.
 */

import { EventEmitter } from 'events';
import { DualAgent } from '../../core/dual-agent.js';
import { ModelOrchestrator } from '../../models/orchestrator.js';
import { MCPServerManager } from '../../mcp/server-manager.js';
import { WorkspaceManager } from '../../core/workspace.js';
import { ConversationManager } from '../../core/conversation-manager.js';
import { StorageProvider } from '../../storage/provider.js';
import { logger } from '../../utils/logger.js';
import { OrchestrationLogger } from '../../utils/orchestration-logger.js';
import { createModelClient } from '../../models/model-client.js';
import { RuntimeConfigError } from '../../utils/errors.js';
import { Message } from '../../models/base.js';
import { PersonaManager } from '../../personas/persona-manager.js';
import { getDefaultFilesystemAllowedPath } from '../../utils/platform.js';
import type { IAgent, AgentChatResponse } from '../../core/agent-interface.js';
import { RuntimeConfigLoader, runtimeConfigLoader } from '../../runtime-config/loader.js';
import { RuntimeConfigCache } from '../../runtime-config/cache.js';
import { AgentSession } from '../../runtime-config/agent-session.js';
import {
  ConversationResult,
  ExternalConversationContext,
  buildConversationCompletion,
  generateConversationSummary,
  shouldGenerateSummary,
} from '../../core/conversation-result.js';

/**
 * OPTIONAL integration hook for completed conversations.
 *
 * Jiva owns the conversation execution and produces a generic ConversationResult
 * when a meaningful interaction completes; an integrator (e.g. Kai) maps that
 * result onto its own memory layer. Absent by default — Jiva behaves exactly as
 * before when no hook is registered.
 *
 * Implementations must tolerate their own failures: Jiva treats a thrown or
 * rejected handler as a logged warning, never fails the conversation, never
 * alters Jiva's conversation history, and never retries unbounded.
 */
export interface ConversationIntegration {
  /** Invoked once when a meaningful conversation completes. */
  onConversationCompleted?(result: ConversationResult): Promise<void> | void;
}

export interface SessionConfig {
  storageProvider: StorageProvider;
  maxConcurrentSessions: number;
  idleTimeoutMs: number;
  /** OPTIONAL integration hook for completed conversations. Default: none. */
  integration?: ConversationIntegration;
}

export interface SessionInfo {
  sessionId: string;
  tenantId: string;
  createdAt: Date;
  lastActivityAt: Date;
  messageCount: number;
  status: 'initializing' | 'active' | 'idle' | 'closing';
}

/**
 * Kai-supplied identity for a session. When `organizationId` and `agentId` are
 * present, storage is rooted under organizations/{organizationId}/agents/{agentId}/
 * instead of the tenant path. `conversationId` lets multiple sessions share one
 * persistent conversation (conversation memory is keyed by it, not by sessionId).
 */
export interface SessionIdentityOptions {
  organizationId?: string;
  agentId?: string;
  conversationId?: string;
  /** Kai contact (end-user) id. Carried for identity lifecycle completeness. */
  contactId?: string;
}

interface ActiveSession {
  agent: IAgent;
  mcpManager: MCPServerManager;
  workspace: WorkspaceManager;
  conversationManager: ConversationManager;
  personaManager: PersonaManager;
  /** Session-scoped storage provider — has a fixed context and does NOT share
   *  mutable state with other sessions. */
  storageProvider: StorageProvider;
  /** Per-session orchestration logger — never shared across tenants. */
  orchestrationLogger: OrchestrationLogger;
  /** Model orchestrator backing this session's agent — reused for summary generation. */
  orchestrator: ModelOrchestrator;
  /** Present when the session was booted from a runtime config (Kai). */
  agentSession?: AgentSession;
  info: SessionInfo;
  /** Kai identity captured at creation — used later (e.g. destroy/persist). */
  identity?: SessionIdentityOptions;
  idleTimer?: NodeJS.Timeout;
}

/**
 * Shared runtime-config cache — keyed by URI, so all sessions for the same
 * agent config re-use one validated document (and one GCS download).
 */
const runtimeConfigCache = new RuntimeConfigCache(runtimeConfigLoader);

export class SessionManager extends EventEmitter {
  private sessions: Map<string, ActiveSession> = new Map();
  /** Deduplicates concurrent creation requests for the same session key. */
  private pendingSessions: Map<string, Promise<ActiveSession>> = new Map();
  private config: SessionConfig;
  private integration?: ConversationIntegration;

  constructor(config: SessionConfig) {
    super();
    this.config = config;
    this.integration = config.integration;
    logger.info(`[SessionManager] Initialized (max: ${config.maxConcurrentSessions}, timeout: ${config.idleTimeoutMs}ms)`);
  }

  /**
   * Get or create a session.
   *
   * Concurrent calls for the same (tenantId, sessionId) are deduplicated:
   * the second caller awaits the same creation Promise so only one session
   * object (and its MCP sub-processes) is ever created per key.
   *
   * When `runtimeConfigUri` is provided (Kai flow), the session is booted from
   * the runtime-config document — model, prompts, MCP servers, features and
   * runtime settings all come from that document instead of GCS config/env.
   */
  async getOrCreateSession(
    tenantId: string,
    sessionId: string,
    runtimeConfigUri?: string,
    identity?: SessionIdentityOptions,
  ): Promise<IAgent> {
    const key = this.getSessionKey(tenantId, sessionId);

    // Fast path — session already active
    if (this.sessions.has(key)) {
      const session = this.sessions.get(key)!;
      this.resetIdleTimer(key);
      session.info.lastActivityAt = new Date();
      session.info.status = 'active';
      logger.debug(`[SessionManager] Reusing session: ${key}`);
      return session.agent;
    }

    // Deduplication — a concurrent request is already creating this session
    if (this.pendingSessions.has(key)) {
      logger.debug(`[SessionManager] Awaiting pending session creation: ${key}`);
      const session = await this.pendingSessions.get(key)!;
      return session.agent;
    }

    // Check session limit
    if (this.sessions.size >= this.config.maxConcurrentSessions) {
      await this.cleanupIdleSessions();
      if (this.sessions.size >= this.config.maxConcurrentSessions) {
        throw new Error(`Maximum concurrent sessions reached (${this.config.maxConcurrentSessions})`);
      }
    }

    // Create new session; register the Promise before awaiting so concurrent
    // callers that arrive while we await find it in pendingSessions.
    logger.info(`[SessionManager] Creating session: ${key}`);
    const codeModeEnabled = process.env.JIVA_CODE_MODE === 'true';
    const bootstrapStartedAt = Date.now();
    const creationPromise = this.createSession(tenantId, sessionId, codeModeEnabled, runtimeConfigUri, identity);
    this.pendingSessions.set(key, creationPromise);

    try {
      const session = await creationPromise;
      this.sessions.set(key, session);
      this.resetIdleTimer(key);

      logger.setSessionId(sessionId);

      if (runtimeConfigUri) {
        logger.info('runtime_config.bootstrap_complete', { tenantId, sessionId, durationMs: Date.now() - bootstrapStartedAt });
      }

      this.emit('sessionCreated', { tenantId, sessionId });
      return session.agent;
    } finally {
      // Always remove from pending, even on error
      this.pendingSessions.delete(key);
    }
  }

  /**
   * Create a new session with all components
   */
  private async createSession(
    tenantId: string,
    sessionId: string,
    codeModeEnabled: boolean,
    runtimeConfigUri?: string,
    identity?: SessionIdentityOptions,
  ): Promise<ActiveSession> {
    const info: SessionInfo = {
      sessionId,
      tenantId,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      messageCount: 0,
      status: 'initializing',
    };

    try {
      // When booting from a runtime config (Kai flow), load + validate the
      // document once (cached per URI) and wrap it in an isolated AgentSession.
      let agentSession: AgentSession | undefined;
      if (runtimeConfigUri) {
        logger.info('runtime_config.requested', { tenantId, sessionId, runtimeConfigUri });
        const cached = await runtimeConfigCache.get(runtimeConfigUri);
        agentSession = new AgentSession({ sessionId, runtimeConfig: cached.config });
        logger.info('runtime_config.session_created', {
          sessionId,
          tenantId,
          provider: agentSession.modelConfig.provider,
          model: agentSession.modelConfig.model,
          timeout: agentSession.timeoutMs,
          maxIterations: agentSession.maxIterations,
          features: agentSession.features,
          mcpServerCount: Object.keys(agentSession.mcpServers).length,
        });
      }

      // Obtain a session-scoped storage provider.  This is a new, isolated
      // instance whose context (tenantId / sessionId / Kai storage base path)
      // is fixed for the lifetime of this session.  It shares the underlying
      // GCS bucket connection and per-namespace config cache with the singleton
      // parent, but has its own immutable context, so concurrent sessions from
      // different tenants/agents never clobber each other's GCS paths.
      const storageProvider = this.config.storageProvider.createSessionScoped({
        tenantId,
        sessionId,
        storageBasePath: this.buildStorageBasePath(identity),
      });

      // Per-session orchestration logger.  Instantiated here (not via the
      // module-level singleton) so every session writes to its own buffer and
      // GCS path — concurrent tenants no longer cross-contaminate log output.
      const orchLogger = new OrchestrationLogger(storageProvider, sessionId);

      // Create model orchestrator — either from the runtime config or from
      // per-tenant GCS config (falling back to env defaults).
      let orchestrator: ModelOrchestrator;
      if (agentSession) {
        const mc = agentSession.modelConfig;
        // Endpoint + API key remain SERVER-LEVEL infrastructure settings
        // (env vars). The model name, temperature and max tokens come from
        // runtimeConfig.model — never hardcoded here.
        const endpoint = process.env.JIVA_MODEL_BASE_URL || '';
        const apiKey = process.env.JIVA_MODEL_API_KEY || '';
        const reasoningModel = createModelClient({
          endpoint,
          apiKey,
          model: mc.model,
          type: 'reasoning',
          temperature: mc.temperature,
          defaultMaxTokens: mc.maxTokens,
          retryPolicy: agentSession.retryPolicy,
          maxRequestsPerMinute: process.env.JIVA_MODEL_MAX_RPM ? parseInt(process.env.JIVA_MODEL_MAX_RPM, 10) : undefined,
        });
        orchestrator = new ModelOrchestrator({ reasoningModel });
      } else {
        // Load or create config
        let modelConfig = await storageProvider.getConfig<{
          reasoning: {
            provider?: string;
            apiKey?: string;
            endpoint: string;
            model?: string;
            defaultModel?: string;
            useHarmonyFormat?: boolean;
            useGoogleADC?: boolean;
            reasoningEffortStrategy?: 'api_param' | 'system_prompt' | 'both';
            defaultMaxTokens?: number;
          };
          multimodal: null;
        }>('models');
        
        // Environment variables are SERVER-LEVEL DEFAULTS only.
        // Per-tenant GCS config takes full precedence — env vars are only applied
        // when no GCS config exists for this tenant (first-ever session).
        const envEndpoint = process.env.JIVA_MODEL_BASE_URL;
        const envApiKey = process.env.JIVA_MODEL_API_KEY;
        const envModel = process.env.JIVA_MODEL_NAME;

        if (!modelConfig) {
          // No per-tenant config yet — bootstrap from environment defaults
          modelConfig = {
            reasoning: {
              provider: process.env.JIVA_MODEL_PROVIDER || 'sarvam',
              apiKey: envApiKey || '',
              endpoint: envEndpoint || 'https://api.sarvam.ai/v1/chat/completions',
              model: envModel || 'sarvam-105b',
              useHarmonyFormat: false,
              reasoningEffortStrategy: 'api_param' as const,
              defaultMaxTokens: 4096,
            },
            multimodal: null,
          };
          await storageProvider.setConfig('models', modelConfig);
        }
        // Per-tenant GCS config exists → use it as-is; do NOT override with env vars.
        // To change a tenant's model, update their config.json in GCS directly.

        // Create model orchestrator
        const rm = modelConfig.reasoning as any;
        const reasoningModel = createModelClient({
          endpoint: rm.endpoint,
          apiKey: rm.apiKey || '',
          model: rm.model || rm.defaultModel,
          type: 'reasoning',
          useHarmonyFormat: rm.useHarmonyFormat ?? false,
          useGoogleADC: rm.useGoogleADC ?? false,
          hasVision: rm.hasVision ?? false,
          reasoningEffortStrategy: rm.reasoningEffortStrategy,
          defaultReasoningEffort: 'high',
          defaultMaxTokens: rm.defaultMaxTokens,
          maxRequestsPerMinute: rm.maxRequestsPerMinute,
        });

        // Tool-calling model: when configured, serves as the PRIMARY model for tool-call
        // execution (reliable standard-JSON tool formatting). The reasoning model acts as
        // the secondary fallback.
        // Configure via JIVA_TOOL_CALLING_MODEL_BASE_URL / JIVA_TOOL_CALLING_MODEL_API_KEY /
        // JIVA_TOOL_CALLING_MODEL_NAME environment variables.
        const tcEndpoint = process.env.JIVA_TOOL_CALLING_MODEL_BASE_URL;
        const tcApiKey   = process.env.JIVA_TOOL_CALLING_MODEL_API_KEY;
        const tcModel    = process.env.JIVA_TOOL_CALLING_MODEL_NAME;
        const toolCallingModel = (tcEndpoint && tcApiKey && tcModel)
          ? createModelClient({
              endpoint: tcEndpoint,
              apiKey: tcApiKey,
              model: tcModel,
              type: 'tool-calling',
              useHarmonyFormat: false, // standard OpenAI format for tool-calling LLMs
              defaultReasoningEffort: 'medium',
            })
          : undefined;

        orchestrator = new ModelOrchestrator({
          reasoningModel,
          multimodalModel: undefined,
          toolCallingModel,
        });
      }

      // Initialize MCP servers per-session
      const mcpManager = new MCPServerManager();

      if (agentSession) {
        // Runtime-config flow: MCP servers come exclusively from
        // runtimeConfig.mcpServers (each enabled server → one client).
        // No hardcoded servers here. Feature flag gates tool usage entirely.
        const enabledMcpServers: Record<string, any> = {};
        if (agentSession.enableTools) {
          for (const [name, config] of Object.entries(agentSession.mcpServers)) {
            enabledMcpServers[name] = config;
          }
        }
        if (Object.keys(enabledMcpServers).length > 0) {
          logger.info(`[SessionManager] Initializing MCP servers from runtime config: ${Object.keys(enabledMcpServers).join(', ')}`);
          await mcpManager.initialize(enabledMcpServers);
        } else {
          logger.info(`[SessionManager] No MCP servers from runtime config (enableTools=${agentSession.enableTools}). Agent runs without external tools.`);
        }
      } else {
        // Resolve allowed filesystem paths from env var, falling back to platform default
        const envAllowedPaths = process.env.MCP_FILESYSTEM_ALLOWED_PATHS;
        const defaultAllowedPath = getDefaultFilesystemAllowedPath();
        const allowedPaths = envAllowedPaths
          ? envAllowedPaths.split(',').map(p => p.trim()).filter(Boolean)
          : [defaultAllowedPath];

        const mcpEnabled = process.env.ENABLE_MCP_SERVERS !== 'false';
        const filesystemEnabled = process.env.MCP_FILESYSTEM_ENABLED !== 'false';

        const baseMcpServers: Record<string, any> = {};

        if (mcpEnabled && filesystemEnabled) {
          baseMcpServers.filesystem = {
            command: 'npx',
            args: ['--no', '@modelcontextprotocol/server-filesystem', ...allowedPaths],
            enabled: true,
          };
          logger.info(`[SessionManager] Filesystem MCP paths: ${allowedPaths.join(', ')}`);
        }

        // Load MCP server config from storage
        const mcpConfig = await storageProvider.getConfig<Array<{
          name: string;
          command: string;
          args?: string[];
          env?: Record<string, string>;
        }>>('mcpServers');
        if (mcpConfig && Array.isArray(mcpConfig)) {
          for (const serverConfig of mcpConfig) {
            // Add to base servers (will override filesystem if configured)
            baseMcpServers[serverConfig.name] = {
              command: serverConfig.command,
              args: serverConfig.args,
              env: serverConfig.env,
              enabled: true,
            };
          }
        }

        // Initialize all MCP servers (base + configured)
        await mcpManager.initialize(baseMcpServers);
      }

      // Initialize workspace
      const workspace = new WorkspaceManager(storageProvider);
      await workspace.initialize();

      // Initialize conversation manager
      const conversationManager = new ConversationManager(storageProvider);

      // Initialize persona manager with per-tenant storage provider
      // This ensures persona config is isolated per tenant, not shared globally
      const personaManager = new PersonaManager([], false, storageProvider);
      await personaManager.initialize();

      // Merge persona MCP servers with session MCP servers
      const personaMCPServers = personaManager.getPersonaMCPServers();
      if (Object.keys(personaMCPServers).length > 0) {
        logger.info(`[SessionManager] Adding ${Object.keys(personaMCPServers).length} MCP servers from active persona`);
        
        for (const [name, config] of Object.entries(personaMCPServers)) {
          try {
            await mcpManager.addServer(name, config as any);
            logger.success(`[SessionManager] Added persona MCP server: ${name}`);
          } catch (error) {
            logger.warn(`[SessionManager] Failed to add persona MCP server '${name}': ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }

      // Load or create conversation
      // Kai flow: the conversation id comes from Kai (`identity.conversationId`)
      // and is independent of the session id, so multiple sessions belonging to
      // the same conversation can restore the same persistent memory. Legacy
      // sessions fall back to the session id as the conversation id.
      // Feature flag: when enableMemory=false (runtime config), the session
      // starts with an empty conversation and does not restore history.
      const conversationId = identity?.conversationId || sessionId;
      let conversationHistory: Message[] = [];
      if (agentSession?.enableMemory === false) {
        logger.info(`[SessionManager] Memory disabled by runtime config — starting fresh conversation`);
      } else {
        const existingConversation = await storageProvider.loadConversation(conversationId);
        if (existingConversation) {
          conversationHistory = existingConversation.messages;
          info.messageCount = conversationHistory.length;
          logger.info(`[SessionManager] Restored conversation '${conversationId}': ${conversationHistory.length} messages`);
        }
      }
      conversationManager.setCurrentConversationId(conversationId);

      // Create agent — CodeAgent for code mode, DualAgent for general mode
      let agent: IAgent;
      if (codeModeEnabled) {
        const { CodeAgent } = await import('../../code/agent.js');
        const lspEnabled = process.env.JIVA_CODE_LSP !== 'false';
        agent = new CodeAgent({
          orchestrator,
          workspace,
          conversationManager,
          maxIterations: agentSession?.maxIterations ?? 50,
          lspEnabled,
          systemPrompt: agentSession?.finalPrompt,
        });
        logger.info('[SessionManager] Using CodeAgent (code mode)');
      } else {
        agent = new DualAgent({
          orchestrator,
          mcpManager,
          workspace,
          conversationManager,
          personaManager,
          maxSubtasks: 20,
          maxIterations: agentSession?.maxIterations ?? 20,
          autoSave: true,
          systemPrompt: agentSession?.finalPrompt,
          orchestrationLogger: orchLogger,
        });
      }

      // Restore persistent conversation memory into the agent so the session
      // starts from the shared conversation history (Kai conversation_id).
      // This is what lets a later session with the same conversation id continue
      // the conversation. Skipped when memory is disabled by the runtime config.
      if (agentSession?.enableMemory !== false && conversationHistory.length > 0) {
        await agent.loadConversation(conversationId);
      }

      info.status = 'active';

      return {
        agent,
        mcpManager,
        workspace,
        conversationManager,
        personaManager,
        storageProvider,
        orchestrationLogger: orchLogger,
        orchestrator,
        agentSession,
        identity,
        info,
      };

    } catch (error) {
      if (error instanceof RuntimeConfigError) {
        logger.error('runtime_config.error', {
          runtimeConfigUri,
          sessionId,
          tenantId,
          code: 'RUNTIME_CONFIG_ERROR',
          message: error.message,
        });
      } else {
        logger.error(`[SessionManager] Failed to create session ${sessionId}:`, error);
      }
      throw error;
    }
  }

  /**
   * Destroy a session and persist state
   */
  async destroySession(tenantId: string, sessionId: string): Promise<void> {
    const key = this.getSessionKey(tenantId, sessionId);
    const session = this.sessions.get(key);

    if (!session) {
      logger.debug(`[SessionManager] Session not found: ${key}`);
      return;
    }

    logger.info(`[SessionManager] Destroying session: ${key}`);
    session.info.status = 'closing';

    // Clear idle timer
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
    }

    try {
      // Use the session's own scoped provider and logger so we write to the
      // right tenant path regardless of which tenant's context is currently
      // set on the shared singleton.
      const { storageProvider, orchestrationLogger: orchLogger } = session;

      // Persist conversation state
      // Feature flag: when enableMemory=false (runtime config), skip persisting
      // conversation history so no memory is retained across sessions.
      // Kai flow: conversations are keyed by the Kai-supplied conversation id so
      // they remain shared and persistent across sessions.
      const conversationId = session.identity?.conversationId || sessionId;
      const conversationHistory = session.agent.getConversationHistory();
      if (conversationHistory.length > 0 && session.agentSession?.enableMemory !== false) {
        const tokenUsage = session.agent.getTokenUsage();
        await storageProvider.saveConversation({
          metadata: {
            id: conversationId,
            created: session.info.createdAt.toISOString(),
            updated: new Date().toISOString(),
            messageCount: conversationHistory.length,
            totalPromptTokens: tokenUsage.promptTokens,
            totalCompletionTokens: tokenUsage.completionTokens,
            totalTokens: tokenUsage.totalTokens,
          },
          messages: conversationHistory,
        });
        logger.debug(`[SessionManager] Persisted ${conversationHistory.length} messages (conversation ${conversationId})`);
      }

      // Session explicitly closed (or idled out) — produce a conversation result
      // when the conversation is substantial. Best-effort: never blocks destroy.
      try {
        await this.finalizeConversation(tenantId, sessionId);
      } catch (error) {
        logger.warn(`[SessionManager] Summary generation on destroy failed for ${key}:`, error);
      }

      // Flush orchestration logs for this session
      await orchLogger.flush();

      // Flush structured logs
      await storageProvider.flushLogs();

      // Clean up session-specific logger context
      logger.clearSessionContext(sessionId);

      // Cleanup agent (shuts down LSP servers in code mode)
      await session.agent.cleanup();

      // Cleanup MCP servers
      await session.mcpManager.cleanup();

    } catch (error) {
      logger.error(`[SessionManager] Error persisting session ${key}:`, error);
    }

    this.sessions.delete(key);
    this.emit('sessionDestroyed', { tenantId, sessionId });
    logger.info(`[SessionManager] Session destroyed: ${key}`);
  }

  /**
   * Get session info
   */
  getSessionInfo(tenantId: string, sessionId: string): SessionInfo | null {
    const key = this.getSessionKey(tenantId, sessionId);
    const session = this.sessions.get(key);
    return session ? { ...session.info } : null;
  }

  /**
   * List all active sessions for a tenant
   */
  listSessions(tenantId: string): SessionInfo[] {
    const sessions: SessionInfo[] = [];
    for (const [key, session] of this.sessions) {
      if (key.startsWith(`${tenantId}:`)) {
        sessions.push({ ...session.info });
      }
    }
    return sessions;
  }

  /**
   * Update activity timestamp (call on each message)
   */
  updateActivity(tenantId: string, sessionId: string): void {
    const key = this.getSessionKey(tenantId, sessionId);
    const session = this.sessions.get(key);
    
    if (session) {
      session.info.lastActivityAt = new Date();
      session.info.messageCount++;
      this.resetIdleTimer(key);
      
      // Ensure logger knows current session context
      logger.setSessionId(sessionId);
    }
  }

  /**
   * Reset idle timer for a session
   */
  private resetIdleTimer(key: string): void {
    const session = this.sessions.get(key);
    if (!session) return;

    // Clear existing timer
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
    }

    // Set new timer
    session.idleTimer = setTimeout(async () => {
      logger.info(`[SessionManager] Session idle timeout: ${key}`);
      const [tenantId, sessionId] = key.split(':');
      await this.destroySession(tenantId, sessionId);
    }, this.config.idleTimeoutMs);
  }

  /**
   * Cleanup idle sessions
   */
  private async cleanupIdleSessions(): Promise<void> {
    const now = Date.now();
    const toDestroy: Array<{ tenantId: string; sessionId: string }> = [];

    for (const [key, session] of this.sessions) {
      const idleMs = now - session.info.lastActivityAt.getTime();
      if (idleMs > this.config.idleTimeoutMs) {
        const [tenantId, sessionId] = key.split(':');
        toDestroy.push({ tenantId, sessionId });
      }
    }

    for (const { tenantId, sessionId } of toDestroy) {
      await this.destroySession(tenantId, sessionId);
    }

    if (toDestroy.length > 0) {
      logger.info(`[SessionManager] Cleaned up ${toDestroy.length} idle session(s)`);
    }
  }

  /**
   * Shutdown all sessions gracefully
   */
  async shutdown(): Promise<void> {
    logger.info(`[SessionManager] Shutting down ${this.sessions.size} session(s)...`);
    
    const shutdownPromises: Promise<void>[] = [];
    for (const [key] of this.sessions) {
      const [tenantId, sessionId] = key.split(':');
      shutdownPromises.push(this.destroySession(tenantId, sessionId));
    }

    await Promise.all(shutdownPromises);
    logger.info('[SessionManager] All sessions shut down');
  }

  /**
   * Get stats
   */
  getStats(): { total: number; byTenant: Record<string, number> } {
    const byTenant: Record<string, number> = {};
    
    for (const [key] of this.sessions) {
      const tenantId = key.split(':')[0];
      byTenant[tenantId] = (byTenant[tenantId] || 0) + 1;
    }

    return {
      total: this.sessions.size,
      byTenant,
    };
  }

  /**
   * Return the agent for an existing session without creating one.
   * Used by the stop endpoint to signal a running chat() call.
   * Returns null if the session does not exist.
   */
  getActiveAgent(tenantId: string, sessionId: string): IAgent | null {
    const key = this.getSessionKey(tenantId, sessionId);
    return this.sessions.get(key)?.agent ?? null;
  }

  /**
   * Return the AgentSession backing an active session (present only when the
   * session was booted from a runtime config). Returns null for legacy sessions.
   */
  getAgentSession(tenantId: string, sessionId: string): AgentSession | null {
    const key = this.getSessionKey(tenantId, sessionId);
    return this.sessions.get(key)?.agentSession ?? null;
  }

  /**
   * Run one agent turn. Sessions booted from a runtime config with a configured
   * `runtime.timeout` enforce that timeout on the turn. Legacy sessions run
   * without a timeout, preserving previous behavior.
   */
  async chatTurn(
    tenantId: string,
    sessionId: string,
    message: string,
    runtimeConfigUri?: string,
    identity?: SessionIdentityOptions,
  ): Promise<AgentChatResponse> {
    const agent = await this.getOrCreateSession(tenantId, sessionId, runtimeConfigUri, identity);
    const timeoutMs = this.sessions.get(this.getSessionKey(tenantId, sessionId))?.agentSession?.timeoutMs;
    if (!timeoutMs) {
      return agent.chat(message);
    }
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      agent.chat(message),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Agent turn timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  private getSessionKey(tenantId: string, sessionId: string): string {
    return `${tenantId}:${sessionId}`;
  }

  /**
   * Produce a generic conversation result for a completed interaction.
   *
   * Runs the meaningfulness guard first: returns null (no LLM call, no summary)
   * for empty/trivial/single-message conversations. When a conversation is
   * substantial, generates a concise summary + key points + outcome using the
   * session's orchestrator. The summary is persisted back into the conversation
   * metadata (existing `summary` field) so a later GCS restore re-exposes it.
   *
   * `externalContext` is caller-supplied background context (e.g. prior
   * interactions, active case) — used as reference for the summary only, never
   * merged into Jiva's own conversation history.
   *
   * When an optional ConversationIntegration is registered, the enriched
   * completion record is delivered to it after persistence. Delivery is
   * fire-and-forget: finalization never waits on the integration, and handler
   * failures are logged without failing or altering the conversation.
   */
  async finalizeConversation(
    tenantId: string,
    sessionId: string,
    externalContext?: ExternalConversationContext,
  ): Promise<ConversationResult | null> {
    const key = this.getSessionKey(tenantId, sessionId);
    const session = this.sessions.get(key);
    if (!session) {
      logger.debug(`[SessionManager] finalizeConversation: no active session ${key}`);
      return null;
    }

    const conversationId = session.identity?.conversationId || sessionId;
    const history = session.agent.getConversationHistory();

    if (!shouldGenerateSummary(history)) {
      logger.debug(`[SessionManager] finalizeConversation: ${conversationId} too trivial to summarize`);
      return null;
    }

    const result = await generateConversationSummary(conversationId, history, session.orchestrator, externalContext);
    if (!result) return null;

    // Enrich the base result with identity/timing/count so the integration layer
    // receives the full completion picture (provider-neutral — never Kai-named).
    const completion = buildConversationCompletion(result, {
      identity: session.identity,
      startedAt: session.info.createdAt.toISOString(),
      endedAt: new Date().toISOString(),
      messageCount: history.length,
    });

    // Persist the summary into the conversation metadata so restores re-expose it.
    try {
      const existing = await session.storageProvider.loadConversation(conversationId);
      const metadata = {
        ...existing?.metadata,
        id: conversationId,
        created: existing?.metadata?.created ?? session.info.createdAt.toISOString(),
        updated: new Date().toISOString(),
        messageCount: history.length,
        summary: completion.summary ?? existing?.metadata?.summary,
      };
      await session.storageProvider.saveConversation({
        metadata,
        messages: existing?.messages ?? history,
      });
      logger.debug(`[SessionManager] Persisted summary for conversation ${conversationId}`);
    } catch (error) {
      logger.warn(`[SessionManager] Failed to persist summary for ${conversationId}:`, error);
    }

    // OPTIONAL integration hook — fire-and-forget, non-blocking. Triggered after
    // persistence and never awaited, so finalization never waits on the external
    // integrator and a slow/failed handler cannot delay or fail the response.
    this.triggerConversationCompletion({ ...completion });

    return completion;
  }

  /**
   * Trigger the optional integration handler without awaiting it.
   *
   * Delivery is fire-and-forget: Jiva does NOT block on the external integrator,
   * and a slow or unavailable integrator cannot delay or fail finalization.
   * Synchronous throws and promise rejections are both caught and logged — never
   * silently swallowed. There is no unbounded retry, Jiva's own conversation
   * history is never handed to the handler, and the handler receives a defensive
   * copy so it cannot mutate the persisted/returned record.
   */
  private triggerConversationCompletion(result: ConversationResult): void {
    const handler = this.integration?.onConversationCompleted;
    if (!handler) return;
    try {
      const outcome = handler(result);
      if (outcome && typeof (outcome as { catch?: unknown }).catch === 'function') {
        (outcome as Promise<void>).catch((error: unknown) => {
          logger.error(`[SessionManager] Integration handler failed for ${result.conversationId}:`, error);
        });
      }
    } catch (error) {
      logger.error(`[SessionManager] Integration handler failed for ${result.conversationId}:`, error);
    }
  }

  /**
   * Kai INTEGRATION BOUNDARY for storage layout.
   *
   * This is the ONLY place (besides the SDK's Kai runtime-config module) where
   * the Kai storage hierarchy is constructed. The generic storage layer must
   * not know that "organizations/{x}/agents/{y}" describes an org + agent — so
   * here we build that prefix and hand the storage layer an OPAQUE
   * `storageBasePath` string.
   *
   * Returns undefined (legacy tenant layout) when Kai identity is absent.
   */
  private buildStorageBasePath(identity?: SessionIdentityOptions): string | undefined {
    if (!identity?.organizationId || !identity?.agentId) {
      return undefined;
    }
    return `organizations/${identity.organizationId}/agents/${identity.agentId}`;
  }
}
