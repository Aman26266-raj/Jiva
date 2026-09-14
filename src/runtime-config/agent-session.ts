/**
 * AgentSession — the isolated, in-memory per-session state that a runtime-config
 * session is built from.
 *
 * Created when a new conversation starts. Inputs: runtimeConfigUri + sessionId.
 * The runtime config is loaded/cached by RuntimeConfigLoader/RuntimeConfigCache,
 * then an AgentSession is constructed that holds every piece needed to boot the
 * agent:
 *   - sessionId
 *   - runtimeConfig (the validated document)
 *   - model config (from runtimeConfig.model)
 *   - final prompt (assembled from runtimeConfig.prompts)
 *   - MCP servers (from runtimeConfig.mcpServers)
 *   - runtime settings (from runtimeConfig.runtime)
 *   - feature flags (from runtimeConfig.features)
 *   - empty conversation memory
 *
 * IMPORTANT: each AgentSession owns its own state — no shared mutable state
 * between sessions. Nothing on this instance is ever shared across tenants.
 */

import { Message } from '../models/base.js';
import {
  RuntimeConfig,
  RuntimeModelConfig,
  RuntimePrompts,
  RuntimeSettings,
  FeatureFlags,
  RuntimeMCPServerConfig,
} from './types.js';
import { assembleFinalPrompt } from './prompts.js';

/** Default feature flags applied when Kai omits `features`. */
const DEFAULT_FEATURES: FeatureFlags = {
  enableMemory: true,
  enableTools: true,
  enableStreaming: true,
  enableHumanEscalation: false,
};

export interface AgentSessionInit {
  /** Client-provided conversation identifier. */
  sessionId: string;
  /** The validated runtime config this session boots from. */
  runtimeConfig: RuntimeConfig;
}

export class AgentSession {
  readonly sessionId: string;
  readonly runtimeConfig: RuntimeConfig;

  readonly modelConfig: RuntimeModelConfig;
  readonly prompts: RuntimePrompts;
  readonly mcpServers: Record<string, RuntimeMCPServerConfig>;
  readonly runtimeSettings: RuntimeSettings;
  readonly features: FeatureFlags;

  /** Per-session conversation memory — empty at creation, never shared. */
  readonly conversationMemory: Message[] = [];

  constructor(init: AgentSessionInit) {
    this.sessionId = init.sessionId;
    this.runtimeConfig = init.runtimeConfig;

    this.modelConfig = init.runtimeConfig.model;
    this.prompts = init.runtimeConfig.prompts;
    this.mcpServers = init.runtimeConfig.mcpServers ?? {};
    this.runtimeSettings = init.runtimeConfig.runtime ?? {};
    this.features = { ...DEFAULT_FEATURES, ...(init.runtimeConfig.features ?? {}) };
  }

  /** The assembled system prompt (agentPrompt + jivaPrompt). */
  get finalPrompt(): string {
    return assembleFinalPrompt(this.prompts.agentPrompt, this.prompts.jivaPrompt);
  }

  /**
   * Max iterations for this session from runtime.iterationLimits.
   * Accepts the Kai scalar form or the legacy `{ maxIterations }` object form.
   */
  get maxIterations(): number | undefined {
    const limits = this.runtimeSettings.iterationLimits;
    return typeof limits === 'number' ? limits : limits?.maxIterations;
  }

  /**
   * Turn timeout in milliseconds from runtime.timeout. Accepts the Kai scalar
   * milliseconds form or the legacy `{ seconds }` object form (seconds → ms).
   */
  get timeoutMs(): number | undefined {
    const timeout = this.runtimeSettings.timeout;
    if (typeof timeout === 'number') return timeout;
    const seconds = timeout?.seconds;
    return seconds !== undefined ? seconds * 1000 : undefined;
  }

  /** Retry policy from runtime.retryPolicy (null/undefined → undefined). */
  get retryPolicy() {
    return this.runtimeSettings.retryPolicy ?? undefined;
  }

  get enableMemory(): boolean {
    return this.features.enableMemory !== false;
  }

  get enableTools(): boolean {
    return this.features.enableTools !== false;
  }

  get enableStreaming(): boolean {
    return this.features.enableStreaming !== false;
  }

  get enableHumanEscalation(): boolean {
    return this.features.enableHumanEscalation === true;
  }
}
