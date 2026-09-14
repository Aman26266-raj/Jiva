/**
 * StorageProvider - Abstract interface for state persistence
 * 
 * Enables Jiva to run on:
 * - Local filesystem (CLI, Desktop)
 * - Cloud storage (GCP Bucket, AWS S3)
 * - In-memory caches (Redis)
 * 
 * IMPORTANT: Context (tenantId, sessionId) must be set before operations
 * - CLI mode: Uses defaults automatically
 * - Cloud mode: Must call setContext() with values from JWT/auth
 */

import {
  StorageInfraConfig,
  StorageContext,
  SavedConversation,
  ConversationMetadata,
  LogEntry,
  JivaState,
} from './types.js';

export abstract class StorageProvider {
  protected infraConfig: StorageInfraConfig;
  protected context: StorageContext | null = null;
  protected logBuffer: LogEntry[] = [];
  protected initialized: boolean = false;

  constructor(infraConfig: StorageInfraConfig) {
    this.infraConfig = infraConfig;
  }

  /**
   * Initialize the storage provider (connect, verify access, etc.)
   */
  abstract initialize(): Promise<void>;

  /**
   * Check if provider is ready
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Create an isolated, session-scoped copy of this provider with a fixed context.
   *
   * IMPORTANT for multi-tenancy: the shared provider singleton holds a single
   * mutable `context` field.  If many concurrent requests each call setContext()
   * on it, they corrupt each other's GCS paths.  Callers (SessionManager) must
   * call this method instead and use the returned instance for all session I/O.
   *
   * The base implementation just sets context on `this` and returns `this` –
   * which is only safe for single-session scenarios (e.g. CLI).  Subclasses
   * that serve concurrent HTTP sessions MUST override this to return a new,
   * context-isolated instance that shares connection/cache resources with the
   * parent but has its own immutable context.
   */
  createSessionScoped(context: StorageContext): StorageProvider {
    // Base/CLI fallback: mutate self (safe for single-session use).
    this.setContext(context);
    return this;
  }

  // ─────────────────────────────────────────────────────────────
  // Context Management (CRITICAL for multi-tenancy)
  // ─────────────────────────────────────────────────────────────

  /**
   * Set the tenant and session context
   * MUST be called before any tenant-specific operations in cloud mode
   * 
   * @param context - Contains tenantId and sessionId from authenticated request
   */
  setContext(context: StorageContext): void {
    if (!context.tenantId || !context.sessionId) {
      throw new Error('Both tenantId and sessionId are required in StorageContext');
    }
    // Normalize the opaque root prefix once, up front, so every later path
    // derivation reads a consistent value.
    this.context = context.storageBasePath !== undefined
      ? { ...context, storageBasePath: this.normalizeStorageBasePath(context.storageBasePath) }
      : context;
  }

  /**
   * Lightweight validation + normalization of the opaque storage-base prefix.
   *
   * The prefix is a RELATIVE storage path owned by the integration layer.
   * We keep the contract small: reject absolute filesystem paths, `..`
   * traversal, and empty path segments; trim a trailing separator. No path
   * abstraction is introduced — providers just join the normalized prefix.
   *
   * @throws Error when the prefix violates the storage path contract.
   */
  protected normalizeStorageBasePath(raw: string): string {
    if (raw.length === 0) {
      throw new Error('storageBasePath must not be empty');
    }
    if (raw.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(raw)) {
      throw new Error(`storageBasePath must be a relative storage path, got: "${raw}"`);
    }
    const segments = raw.replace(/\/+$/, '').split('/');
    for (const segment of segments) {
      if (segment === '') {
        throw new Error(`storageBasePath must not contain empty path segments, got: "${raw}"`);
      }
      if (segment === '..') {
        throw new Error(`storageBasePath must not contain '..', got: "${raw}"`);
      }
    }
    return segments.join('/');
  }

  /**
   * Get current context
   */
  getContext(): StorageContext | null {
    return this.context;
  }

  /**
   * Check if context is set and valid
   */
  hasContext(): boolean {
    return this.context !== null && 
           !!this.context.tenantId && 
           !!this.context.sessionId;
  }

  /**
   * Ensure context is set before operations
   * @throws Error if context not set
   */
  protected requireContext(): StorageContext {
    if (!this.context) {
      throw new Error(
        'Storage context not set. Call setContext({tenantId, sessionId}) before performing operations. ' +
        'In cloud mode, extract these from the authenticated JWT.'
      );
    }
    return this.context;
  }

  // ─────────────────────────────────────────────────────────────
  // Configuration (tenant-level)
  // ─────────────────────────────────────────────────────────────

  /**
   * Get a configuration value
   */
  abstract getConfig<T>(key: string): Promise<T | undefined>;

  /**
   * Set a configuration value
   */
  abstract setConfig<T>(key: string, value: T): Promise<void>;

  /**
   * Get all configuration as object
   */
  abstract getAllConfig(): Promise<Record<string, any>>;

  // ─────────────────────────────────────────────────────────────
  // Conversations (session-level)
  // ─────────────────────────────────────────────────────────────

  /**
   * Save a conversation
   * @returns The conversation ID
   */
  abstract saveConversation(conversation: SavedConversation): Promise<string>;

  /**
   * Load a conversation by ID
   */
  abstract loadConversation(id: string): Promise<SavedConversation | null>;

  /**
   * List all conversations for the tenant
   */
  abstract listConversations(): Promise<ConversationMetadata[]>;

  /**
   * Delete a conversation
   */
  abstract deleteConversation(id: string): Promise<void>;

  // ─────────────────────────────────────────────────────────────
  // Directive (workspace-level)
  // ─────────────────────────────────────────────────────────────

  /**
   * Load directive content for a workspace
   * @param workspacePath - The workspace identifier/path
   */
  abstract loadDirective(workspacePath: string): Promise<string | undefined>;

  /**
   * Save directive content (for cloud scenarios where directive is uploaded)
   */
  abstract saveDirective(workspacePath: string, content: string): Promise<void>;

  // ─────────────────────────────────────────────────────────────
  // Logging (session-level, buffered)
  // ─────────────────────────────────────────────────────────────

  /**
   * Append a log entry to the buffer
   * Logs are held in memory until flush() is called
   */
  appendLog(entry: LogEntry): void {
    this.logBuffer.push({
      ...entry,
      timestamp: entry.timestamp || new Date().toISOString(),
    });
  }

  /**
   * Append raw string content to a log file (for orchestration logs)
   * This is separate from appendLog() which buffers structured LogEntry objects
   */
  abstract appendToLog(key: string, content: string): Promise<void>;

  /**
   * Flush buffered logs to persistent storage
   */
  abstract flushLogs(): Promise<void>;

  /**
   * Get current log buffer (for debugging)
   */
  getLogBuffer(): LogEntry[] {
    return [...this.logBuffer];
  }

  /**
   * Clear the log buffer
   */
  clearLogBuffer(): void {
    this.logBuffer = [];
  }

  // ─────────────────────────────────────────────────────────────
  // State Snapshots (for cloud functions)
  // ─────────────────────────────────────────────────────────────

  /**
   * Export complete state for cloud function handoff
   */
  abstract exportState(): Promise<JivaState>;

  /**
   * Import state from a previous export
   */
  abstract importState(state: JivaState): Promise<void>;

  // ─────────────────────────────────────────────────────────────
  // Path Helpers (for implementations)
  // ─────────────────────────────────────────────────────────────

  /**
   * Get the storage root for the current identity.
   *
   * When the integration layer supplied an opaque `storageBasePath` prefix it
   * takes precedence over tenantId; otherwise the legacy tenant layout is used.
   * The provider treats both as opaque — it never interprets path segments.
   */
  private getStorageBasePath(): string {
    const ctx = this.requireContext();
    if (ctx.storageBasePath !== undefined) {
      return `${ctx.storageBasePath}/`;
    }
    return `${ctx.tenantId}/`;
  }

  /**
   * Get the base path for a tenant
   * Format: {storageBasePath}/ or {tenantId}/
   */
  protected getTenantPath(): string {
    return this.getStorageBasePath();
  }

  /**
   * Get the path for a session
   * Format: {base}/sessions/{sessionId}/
   */
  protected getSessionPath(): string {
    const ctx = this.requireContext();
    return `${this.getStorageBasePath()}sessions/${ctx.sessionId}/`;
  }

  /**
   * Get the path for conversations
   * Format: {base}/conversations/
   */
  protected getConversationsPath(): string {
    return `${this.getStorageBasePath()}conversations/`;
  }

  /**
   * Get the path for config
   * Format: {base}/config.json
   */
  protected getConfigPath(): string {
    return `${this.getStorageBasePath()}config.json`;
  }

  /**
   * Get the path for session logs. Session-scoped artifacts (including the
   * orchestration logger's org/worker/manager logs) live under the session dir.
   * Format: {base}/sessions/{sessionId}/
   */
  protected getLogsPath(): string {
    const ctx = this.requireContext();
    return `${this.getStorageBasePath()}sessions/${ctx.sessionId}/`;
  }
}
