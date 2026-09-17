/**
 * Chat routes - REST API with Server-Sent Events (SSE) streaming
 */

import { Express, Request, Response } from 'express';
import { SessionManager } from '../session-manager.js';
import { validateAgentConfig } from '../agent-config.js';
import { KaiValidationError, resolveChatIdentity } from '../chat-identity.js';
import { parseExternalContext, ExternalConversationContext } from '../../../core/conversation-result.js';
import { logger } from '../../../utils/logger.js';
import { getDefaultFilesystemAllowedPath } from '../../../utils/platform.js';
import {
  assertRuntimeModelMatchesEnvironment,
  resolveJivaModelEnvironment,
} from '../model-environment.js';

/**
 * Resolve the Jiva-owned run sessionId + Kai identity for a chat request.
 * Body-supplied Kai identity wins over the auth context. Throws
 * KaiValidationError when the Kai flow contract is violated (→ HTTP 400).
 */
function resolveIdentity(req: Request) {
  return resolveChatIdentity(req.auth!, req.body);
}

function sendKaiValidationError(res: Response, error: unknown): void {
  if (error instanceof KaiValidationError || (error instanceof Error && error.message.startsWith('context'))) {
    res.status(400).json({ error: error.message });
    return;
  }
  res.status(500).json({
    error: 'Failed to process message',
    message: error instanceof Error ? error.message : 'Unknown error',
  });
}

/**
 * Resolve the optional trusted external-context payload. Returns undefined when
 * absent; propagates a 400 when present but malformed.
 */
function resolveExternalContext(req: Request): ExternalConversationContext | undefined {
  try {
    return parseExternalContext(req.body?.context);
  } catch (error) {
    throw new KaiValidationError(error instanceof Error ? error.message : 'Invalid context payload');
  }
}

export function setupChatRoutes(app: Express, sessionManager: SessionManager): void {
  /**
   * Send a message (non-streaming)
   * POST /api/chat
   *
   * Optional body field `agentConfig` supplies per-session overrides for the
   * "create-on-chat" shortcut path (session is created on first chat if it
   * doesn't exist). It is validated before session creation.
   */
  app.post('/api/chat', async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.auth!;
      const { message, endConversation } = req.body;
      const runtimeConfigUri = req.body.runtimeConfigUri ?? req.body.configUrl;

      if (!message || typeof message !== 'string') {
        res.status(400).json({ error: 'Message is required and must be a string' });
        return;
      }

      // Validate per-session agentConfig (if supplied) before creating a session.
      const agentConfig = req.body?.agentConfig;
      const validation = validateAgentConfig(agentConfig);
      if (!validation.valid) {
        res.status(400).json({
          error: 'Invalid agentConfig',
          details: validation.errors,
        });
        return;
      }

      // Resolve Jiva-owned run sessionId + Kai identity. First request in a Kai
      // conversation gets a fresh conv-{uuid}; subsequent requests reuse it —
      // the resolved sessionId IS the conversationId so the same live session
      // is reused while active, and conversation memory restores from GCS if it
      // has idled out.
      const { sessionId, identity, conversationId } = resolveIdentity(req);
      const externalContext = resolveExternalContext(req);

      // Get or create session and process message
      // (runtime-config sessions enforce their configured turn timeout)
      const response = await sessionManager.chatTurn(tenantId, sessionId, message, runtimeConfigUri, identity, agentConfig);

      // Update activity
      sessionManager.updateActivity(tenantId, sessionId);

      // When the interaction is explicitly closed, produce a meaningful
      // conversation result (summary + key points + outcome). Absent for
      // trivial conversations and for ongoing turns.
      let conversation: Awaited<ReturnType<SessionManager['finalizeConversation']>> = null;
      if (endConversation === true) {
        conversation = await sessionManager.finalizeConversation(tenantId, sessionId, externalContext);
      }

      res.status(200).json({
        success: true,
        conversationId,
        response: response.content,
        iterations: response.iterations,
        toolsUsed: response.toolsUsed,
        // toolCalls is undefined for CodeAgent (code-mode) sessions → omitted
        // from JSON. Only the Chat-mode (DualAgent) path threads args through.
        ...(response.toolCalls !== undefined && { toolCalls: response.toolCalls }),
        ...(conversation && { conversation }),
        ...(response.plan !== undefined && { plan: response.plan }),
        ...(response.tokenUsage && { tokenUsage: response.tokenUsage }),
      });
    } catch (error) {
      logger.error('[API] Chat error:', error);
      sendKaiValidationError(res, error);
    }
  });

  /**
   * Send a message with streaming (Server-Sent Events)
   * POST /api/chat/stream
   *
   * Optional body field `agentConfig` supplies per-session overrides for the
   * "create-on-chat" shortcut path. It is validated BEFORE the SSE headers are
   * sent, so a bad config returns a normal JSON 400 instead of an error
   * mid-stream.
   */
  app.post('/api/chat/stream', async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.auth!;
      const { message, endConversation } = req.body;
      const runtimeConfigUri = req.body.runtimeConfigUri ?? req.body.configUrl;

      if (!message || typeof message !== 'string') {
        res.status(400).json({ error: 'Message is required and must be a string' });
        return;
      }

      // Validate per-session agentConfig BEFORE sending SSE headers, so an
      // invalid config returns a normal JSON 400 rather than an error event
      // mid-stream (which clients can't easily surface as a creation failure).
      const agentConfig = req.body?.agentConfig;
      const validation = validateAgentConfig(agentConfig);
      if (!validation.valid) {
        res.status(400).json({
          error: 'Invalid agentConfig',
          details: validation.errors,
        });
        return;
      }

      // Resolve Jiva-owned run sessionId + Kai identity (same semantics as /api/chat).
      const { sessionId, identity, conversationId } = resolveIdentity(req);
      const externalContext = resolveExternalContext(req);

      // Get or create session
      await sessionManager.getOrCreateSession(tenantId, sessionId, runtimeConfigUri, identity, agentConfig);

      // Respect features.enableStreaming — when streaming is disabled by the
      // runtime config, return a plain JSON response instead of an SSE stream.
      const agentSession = sessionManager.getAgentSession(tenantId, sessionId);
      if (agentSession && !agentSession.enableStreaming) {
        const response = await sessionManager.chatTurn(tenantId, sessionId, message, runtimeConfigUri, identity, agentConfig);
        sessionManager.updateActivity(tenantId, sessionId);

        let conversation: Awaited<ReturnType<SessionManager['finalizeConversation']>> = null;
        if (endConversation === true) {
          conversation = await sessionManager.finalizeConversation(tenantId, sessionId, externalContext);
        }

        res.status(200).json({
          success: true,
          conversationId,
          response: response.content,
          iterations: response.iterations,
          toolsUsed: response.toolsUsed,
          ...(response.toolCalls !== undefined && { toolCalls: response.toolCalls }),
          ...(conversation && { conversation }),
          ...(response.plan !== undefined && { plan: response.plan }),
          ...(response.tokenUsage && { tokenUsage: response.tokenUsage }),
        });
        return;
      }

      // Setup SSE
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      // Helper to send SSE message
      const sendEvent = (event: string, data: any) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      try {
        sendEvent('status', { message: 'Processing request...' });

        // Process message (runtime-config sessions enforce their configured turn timeout)
        const response = await sessionManager.chatTurn(tenantId, sessionId, message, runtimeConfigUri, identity, agentConfig);

        // Update activity
        sessionManager.updateActivity(tenantId, sessionId);

        // Produce a conversation result when the interaction is explicitly closed.
        let conversation: Awaited<ReturnType<SessionManager['finalizeConversation']>> = null;
        if (endConversation === true) {
          conversation = await sessionManager.finalizeConversation(tenantId, sessionId, externalContext);
        }

        // Send response
        sendEvent('response', {
          conversationId,
          content: response.content,
          iterations: response.iterations,
          toolsUsed: response.toolsUsed,
          ...(conversation && { conversation }),
          ...(response.plan !== undefined && { plan: response.plan }),
          ...(response.tokenUsage && { tokenUsage: response.tokenUsage }),
        });

        sendEvent('done', { success: true });
        res.end();

      } catch (error) {
        logger.error('[API] Chat stream error:', error);
        sendEvent('error', { 
          message: error instanceof Error ? error.message : 'Unknown error'
        });
        res.end();
      }

    } catch (error) {
      logger.error('[API] Chat stream setup error:', error);
      sendKaiValidationError(res, error);
    }
  });

  /**
   * Stop an ongoing agent turn (cooperative stop — finishes current step then exits)
   * POST /api/chat/stop
   */
  app.post('/api/chat/stop', async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.auth!;
      const { sessionId } = resolveIdentity(req);
      const agent = sessionManager.getActiveAgent(tenantId, sessionId);
      if (!agent) {
        res.status(404).json({ error: 'No active session found' });
        return;
      }
      agent.stop();
      res.status(200).json({ success: true, message: 'Stop signal sent — agent will halt after current step' });
    } catch (error) {
      logger.error('[API] Failed to stop agent:', error);
      res.status(500).json({ error: 'Failed to send stop signal', message: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  /**
   * Get conversation history
   * GET /api/chat/history
   */
  app.get('/api/chat/history', async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.auth!;

      // Resolve the Kai identity (conversation scoped to org/agent) so history
      // is read from the same run session the chat flow uses.
      const { sessionId, identity } = resolveIdentity(req);

      // Get session
      const agent = await sessionManager.getOrCreateSession(tenantId, sessionId, undefined, identity);
      const history = agent.getConversationHistory();

      res.status(200).json({
        success: true,
        history,
        count: history.length,
      });
    } catch (error) {
      logger.error('[API] Failed to get history:', error);
      sendKaiValidationError(res, error);
    }
  });

  /**
   * Run a message through the Evaluator Harness.
   * The main agent processes the request, then the evaluator validates completion
   * and nudges the main agent if gaps are found.
   *
   * POST /api/chat/harness
   * Body: { message: string, harness: "evaluator", conversationId?: string }
   */
  app.post('/api/chat/harness', async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.auth!;
      const { message, runtimeConfigUri } = req.body;

      if (!message || typeof message !== 'string') {
        res.status(400).json({ error: 'message is required and must be a string' });
        return;
      }

      // Resolve Jiva-owned run sessionId + Kai identity (same semantics as /api/chat).
      const { sessionId, identity, conversationId } = resolveIdentity(req);

      // Get the main agent session (creates one if needed)
      const mainAgent = await sessionManager.getOrCreateSession(tenantId, sessionId, runtimeConfigUri, identity);
      sessionManager.updateActivity(tenantId, sessionId);

      // Build evaluator harness — when the session was booted from a runtime
      // config, the model name, temperature and max tokens come from
      // AgentSession.modelConfig. Endpoint/apiKey remain server-level env infra.
      const { createEvaluatorHarness } = await import('../../../evaluator/index.js');

      const agentSession = sessionManager.getAgentSession(tenantId, sessionId);
      const modelEnvironment = resolveJivaModelEnvironment();
      if (agentSession) {
        assertRuntimeModelMatchesEnvironment(agentSession.modelConfig, modelEnvironment);
      }
      const evalEndpoint = modelEnvironment.endpoint;
      const evalApiKey = modelEnvironment.apiKey;
      const evalModel = agentSession?.modelConfig.model ?? modelEnvironment.model;

      const tcEndpoint = process.env.JIVA_TOOL_CALLING_MODEL_BASE_URL;
      const tcApiKey = process.env.JIVA_TOOL_CALLING_MODEL_API_KEY;
      const tcModel = process.env.JIVA_TOOL_CALLING_MODEL_NAME;

      const orchestratorCfg = {
        endpoint: evalEndpoint,
        apiKey: evalApiKey,
        model: evalModel,
        useHarmonyFormat: false,
        ...(agentSession?.modelConfig.temperature !== undefined && { temperature: agentSession.modelConfig.temperature }),
        ...(agentSession?.modelConfig.maxTokens !== undefined && { defaultMaxTokens: agentSession.modelConfig.maxTokens }),
        ...(tcEndpoint && tcApiKey && tcModel && {
          toolCallingEndpoint: tcEndpoint,
          toolCallingApiKey: tcApiKey,
          toolCallingModel: tcModel,
        }),
      };

      // MCP servers for evaluator — filesystem access to validate produced files
      const envAllowedPaths = process.env.MCP_FILESYSTEM_ALLOWED_PATHS;
      const defaultAllowedPath = getDefaultFilesystemAllowedPath();
      const allowedPaths = envAllowedPaths
        ? envAllowedPaths.split(',').map((p) => p.trim()).filter(Boolean)
        : [defaultAllowedPath];

      const evalMcpServers: Record<string, any> = {
        filesystem: {
          command: 'npx',
          args: ['--no', '@modelcontextprotocol/server-filesystem', ...allowedPaths],
          enabled: true,
        },
      };

      const harness = await createEvaluatorHarness(mainAgent, evalMcpServers, orchestratorCfg, {
        verbose: false,
      });

      // Enforce the runtime-config turn timeout around the full harness run
      // (the evaluator drives the main agent internally, so it cannot go
      // through SessionManager.chatTurn directly).
      const timeoutMs = agentSession?.timeoutMs;
      const harnessRun = harness.run(message, { targetConversationId: conversationId });
      const result = timeoutMs
        ? await Promise.race([
            harnessRun,
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`Evaluator harness timed out after ${timeoutMs}ms`)), timeoutMs),
            ),
          ])
        : await harnessRun;

      // Cleanup evaluator MCP servers (main agent cleanup is handled by session manager)
      await harness['evaluatorAgent']['mcpManager'].cleanup();

      res.status(200).json({
        success: true,
        conversationId,
        mainAgentResponse: result.mainAgentResponse,
        mainAgentIterations: result.mainAgentIterations,
        evaluation: result.evaluation,
        mainAgentTokenUsage: result.mainAgentTokenUsage,
        evaluatorTokenUsage: result.evaluatorTokenUsage,
      });
    } catch (error) {
      logger.error('[API] Harness error:', error);
      sendKaiValidationError(res, error);
    }
  });

  /**
   * Clear conversation history
   * DELETE /api/chat/history
   */
  app.delete('/api/chat/history', async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.auth!;
      const { sessionId } = resolveIdentity(req);

      // Destroy and recreate session to clear history
      await sessionManager.destroySession(tenantId, sessionId);

      res.status(200).json({
        success: true,
        message: 'Conversation history cleared',
      });
    } catch (error) {
      logger.error('[API] Failed to clear history:', error);
      res.status(500).json({ 
        error: 'Failed to clear history',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });
}
