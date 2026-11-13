/**
 * Session management routes
 */

import { Express, Request, Response } from 'express';
import { SessionManager } from '../session-manager.js';
import { validateAgentConfig } from '../agent-config.js';
import { logger } from '../../../utils/logger.js';
import type { TrustedCustomerContext } from '../../../core/types/agent-context.js';

export function setupSessionRoutes(app: Express, sessionManager: SessionManager): void {
  /**
   * Create or restore a session
   * POST /api/session
   *
   * Optional body field `agentConfig` supplies per-session overrides (model,
   * tool-calling model, MCP servers, code-mode LSP, max iterations, workspace
   * dir). It is structurally validated BEFORE any session or MCP subprocess is
   * created, so an invalid config returns a 400 without side effects.
   */
  app.post('/api/session', async (req: Request, res: Response) => {
    try {
      const { tenantId, sessionId, organizationId, agentId, contactId, conversationId, customerIdentityVerified } = req.auth!;
      const runtimeConfigUri = req.body?.runtimeConfigUri ?? req.body?.configUrl;
      const suppliedCustomerContext = req.body?.customerContext;
      const suppliedVisitorVerification = req.body?.visitorVerification;
      // Keep the signed tenant/agent context available even for a public
      // visitor, but never promote the transport's isolated visitor contact to
      // a trusted customer. Client MCP OTP can upgrade this live context later.
      let trustedCustomer: TrustedCustomerContext | undefined = organizationId && agentId
        ? {
          organizationId,
          agentId,
          ...(conversationId ? { conversationId } : {}),
          ...(customerIdentityVerified === true && contactId ? { contactId } : {}),
          identityVerification: {
            status: customerIdentityVerified === true ? 'verified' : 'unverified',
            ...(customerIdentityVerified === true ? { source: 'host_token' as const } : {}),
          },
        }
        : undefined;
      if (customerIdentityVerified !== true && suppliedVisitorVerification !== undefined && trustedCustomer) {
        const suppliedPhone = typeof suppliedVisitorVerification?.phoneNumber === 'string'
          ? suppliedVisitorVerification.phoneNumber.replace(/[\s().-]/g, '').trim()
          : '';
        const phoneNumber = suppliedPhone
          ? (suppliedPhone.startsWith('+') ? suppliedPhone : `+${suppliedPhone}`)
          : undefined;
        const suppliedEmail = typeof suppliedVisitorVerification?.email === 'string'
          ? suppliedVisitorVerification.email.trim().toLowerCase()
          : '';
        const email = suppliedEmail || undefined;
        if (
          (phoneNumber && !/^\+[1-9]\d{7,14}$/.test(phoneNumber))
          || (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))
        ) {
          res.status(400).json({ error: 'Invalid visitor verification context' });
          return;
        }
        trustedCustomer.visitorVerification = {
          openCaseAvailable: suppliedVisitorVerification?.openCaseAvailable === true,
          ...(suppliedVisitorVerification?.openCaseAvailable === true
            ? { openCaseOfferStatus: 'pending' as const }
            : {}),
          ...(phoneNumber ? { phoneNumber } : {}),
          ...(email ? { email } : {}),
        };
      }
      if (suppliedCustomerContext !== undefined) {
        const suppliedPhoneNumber = typeof suppliedCustomerContext?.phoneNumber === 'string'
          ? suppliedCustomerContext.phoneNumber.trim()
          : '';
        const phoneNumber = suppliedPhoneNumber.startsWith('+')
          ? suppliedPhoneNumber
          : `+${suppliedPhoneNumber}`;
        // Normalize international digits to one E.164-style representation so
        // every downstream customer lookup receives the same value.
        if (suppliedCustomerContext?.phoneVerified !== true || !/^\+[1-9]\d{7,14}$/.test(phoneNumber)) {
          res.status(400).json({ error: 'Invalid verified customer context' });
          return;
        }
        let caseOffer: TrustedCustomerContext['caseOffer'];
        const suppliedOffer = suppliedCustomerContext?.caseOffer;
        if (suppliedOffer !== undefined) {
          const cases = Array.isArray(suppliedOffer?.cases)
            ? suppliedOffer.cases.slice(0, 5).flatMap((entry: unknown) => {
              if (!entry || typeof entry !== 'object') return [];
              const value = entry as Record<string, unknown>;
              const caseNumber = typeof value.caseNumber === 'string'
                ? value.caseNumber.trim().slice(0, 80)
                : '';
              const caseId = typeof value.caseId === 'string'
                ? value.caseId.trim().slice(0, 120)
                : '';
              const subject = typeof value.subject === 'string'
                ? value.subject.trim().slice(0, 160)
                : null;
              return caseNumber ? [{ ...(caseId ? { caseId } : {}), caseNumber, subject }] : [];
            })
            : [];
          const offerStatus = suppliedOffer?.status;
          const selectedCaseNumber = typeof suppliedOffer?.selectedCaseNumber === 'string'
            ? suppliedOffer.selectedCaseNumber.trim().slice(0, 80)
            : undefined;
          const selectedIsOffered = selectedCaseNumber
            ? cases.some((item: { caseNumber: string; subject: string | null }) => item.caseNumber === selectedCaseNumber)
            : false;
          if (
            (offerStatus !== 'pending' && offerStatus !== 'accepted') ||
            cases.length === 0 ||
            (offerStatus === 'accepted' && !selectedIsOffered)
          ) {
            res.status(400).json({ error: 'Invalid case offer context' });
            return;
          }
          caseOffer = {
            status: offerStatus,
            cases,
            ...(selectedCaseNumber ? { selectedCaseNumber } : {}),
          };
        }
        trustedCustomer = {
          phoneNumber,
          phoneVerified: true,
          ...(organizationId ? { organizationId } : {}),
          ...(agentId ? { agentId } : {}),
          ...(contactId ? { contactId } : {}),
          ...(conversationId ? { conversationId } : {}),
          ...(caseOffer ? { caseOffer } : {}),
          identityVerification: {
            status: 'verified',
            source: 'host_token',
            method: 'phone',
            verifiedAt: new Date().toISOString(),
          },
        };
      }

      // Validate per-session agentConfig (if supplied) before creating anything.
      const agentConfig = req.body?.agentConfig;
      const validation = validateAgentConfig(agentConfig);
      if (!validation.valid) {
        res.status(400).json({
          error: 'Invalid agentConfig',
          details: validation.errors,
        });
        return;
      }

      // Get or create session — Kai org/agent/conversation ids root storage under
      // the org/agent hierarchy and share one persistent conversation.
      await sessionManager.getOrCreateSession(tenantId, sessionId, runtimeConfigUri, {
        organizationId,
        agentId,
        conversationId,
        trustedCustomer,
      }, agentConfig);

      const info = sessionManager.getSessionInfo(tenantId, sessionId);

      res.status(200).json({
        success: true,
        session: info,
      });
    } catch (error) {
      logger.error('[API] Failed to create session:', error);
      res.status(500).json({
        error: 'Failed to create session',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  /**
   * Get session info
   * GET /api/session/:sessionId
   */
  app.get('/api/session/:sessionId', async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.auth!;
      const { sessionId } = req.params;

      const info = sessionManager.getSessionInfo(tenantId, sessionId);
      
      if (!info) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      res.status(200).json({ success: true, session: info });
    } catch (error) {
      logger.error('[API] Failed to get session:', error);
      res.status(500).json({ 
        error: 'Failed to get session',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  /**
   * Get the live status of an in-flight agent turn.
   * GET /api/session/:sessionId/status
   *
   * Returns the latest orchestration event the session's agent emitted while
   * processing a `POST /api/chat` turn (e.g. "Planning execution…",
   * "Running filesystem__read_file…", "Synthesizing results…"). Designed to be
   * polled concurrently from a second HTTP request while a chat turn is in
   * flight — Node's event loop services this poll while `agent.chat()` awaits
   * the model provider.
   *
   * Returns 404 if the session does not exist (an expected poll outcome, e.g.
   * polling before the session has been created or after it was destroyed —
   * not an error). Returns 200 with `{ status }` otherwise.
   */
  app.get('/api/session/:sessionId/status', async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.auth!;
      const { sessionId } = req.params;

      const status = sessionManager.getSessionStatus(tenantId, sessionId);

      if (status === null) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      res.status(200).json({ status });
    } catch (error) {
      logger.error('[API] Failed to get session status:', error);
      res.status(500).json({
        error: 'Failed to get session status',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * List sessions for tenant
   * GET /api/sessions
   */
  app.get('/api/sessions', async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.auth!;
      
      const sessions = sessionManager.listSessions(tenantId);
      
      res.status(200).json({
        success: true,
        sessions,
        count: sessions.length,
      });
    } catch (error) {
      logger.error('[API] Failed to list sessions:', error);
      res.status(500).json({ 
        error: 'Failed to list sessions',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  /**
   * Delete session
   * DELETE /api/session/:sessionId
   */
  app.delete('/api/session/:sessionId', async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.auth!;
      const { sessionId } = req.params;

      await sessionManager.destroySession(tenantId, sessionId);
      
      res.status(200).json({ success: true, message: 'Session deleted' });
    } catch (error) {
      logger.error('[API] Failed to delete session:', error);
      res.status(500).json({ 
        error: 'Failed to delete session',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  /**
   * Get token usage for the active session
   * GET /api/stats/tokens
   */
  app.get('/api/stats/tokens', async (req: Request, res: Response) => {
    try {
      const { tenantId, sessionId } = req.auth!;
      const agent = sessionManager.getActiveAgent(tenantId, sessionId);
      if (!agent) {
        res.status(404).json({ error: 'No active session found' });
        return;
      }
      res.status(200).json({ success: true, sessionId, tokenUsage: agent.getTokenUsage() });
    } catch (error) {
      logger.error('[API] Failed to get token usage:', error);
      res.status(500).json({
        error: 'Failed to get token usage',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * Get manager stats
   * GET /api/stats
   */
  app.get('/api/stats', async (req: Request, res: Response) => {
    try {
      const stats = sessionManager.getStats();
      
      res.status(200).json({
        success: true,
        stats,
      });
    } catch (error) {
      logger.error('[API] Failed to get stats:', error);
      res.status(500).json({ 
        error: 'Failed to get stats',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });
}
