/**
 * RuntimeConfig types — the runtime-config.json document Kai publishes to GCS.
 *
 * Contract with Kai:
 *   gs://kai-jiva-state-dev/runtime/organizations/{organizationId}/agents/{agentId}/runtime-config.json
 *
 * IMPORTANT: This schema is owned by Kai. Jiva must NOT modify it — it only
 * reads and validates. Every field Jiva needs to boot a session (model,
 * prompts, MCP servers, features, runtime settings) comes from here.
 */

import { z } from 'zod';

// ─────────────────────────────────────────────────────────────
// Model
// ─────────────────────────────────────────────────────────────

const RuntimeModelConfigSchema = z.object({
  /** Provider name (e.g. 'openai-compatible', 'sarvam', 'krutrim', 'groq'). */
  provider: z.string(),
  /** Model identifier served by the provider. */
  model: z.string(),
  /** Sampling temperature. */
  temperature: z.number().optional(),
  /** Max output tokens for completions. */
  maxTokens: z.number().optional(),
});

// ─────────────────────────────────────────────────────────────
// Prompts
// ─────────────────────────────────────────────────────────────

const RuntimePromptsSchema = z.object({
  /** The agent-specific system prompt authored in Kai. */
  agentPrompt: z.string(),
  /** Jiva's own system prompt (runtime behavior). */
  jivaPrompt: z.string(),
});

// ─────────────────────────────────────────────────────────────
// Runtime settings
// ─────────────────────────────────────────────────────────────

const RuntimeTimeoutSchema = z.object({
  /** Overall turn timeout, in seconds. */
  seconds: z.number().nonnegative().optional(),
});

const RuntimeIterationLimitsSchema = z.object({
  /** Max agent loop iterations per turn. */
  maxIterations: z.number().int().nonnegative().optional(),
});

const RuntimeRetryPolicySchema = z.object({
  /** Max retries for transient failures. */
  maxRetries: z.number().int().nonnegative().optional(),
  /** Base retry delay, in seconds. */
  retryBaseDelay: z.number().nonnegative().optional(),
  /** Max backoff, in seconds. */
  maxBackoff: z.number().nonnegative().optional(),
});

const RuntimeSettingsSchema = z.object({
  /** Turn timeout in milliseconds (Kai) or legacy `{ seconds }` object form. */
  timeout: z.union([z.number().nonnegative(), RuntimeTimeoutSchema]).optional(),
  /** Max agent loop iterations per turn (Kai) or legacy `{ maxIterations }` object form. */
  iterationLimits: z.union([z.number().int().nonnegative(), RuntimeIterationLimitsSchema]).optional(),
  /** Retry policy for transient failures. Kai publishes null when unset. */
  retryPolicy: RuntimeRetryPolicySchema.nullish(),
});

// ─────────────────────────────────────────────────────────────
// Voice (reserved — Kai may publish it; Jiva does not use it yet)
// ─────────────────────────────────────────────────────────────

const VoiceConfigSchema = z.record(z.unknown()).optional();

// ─────────────────────────────────────────────────────────────
// Feature flags — configure runtime behavior only
// ─────────────────────────────────────────────────────────────

const FeatureFlagsSchema = z.object({
  /** When false, disable conversation memory/persistence. */
  enableMemory: z.boolean().optional(),
  /** When false, disable tool/MCP usage. */
  enableTools: z.boolean().optional(),
  /** When false, disable streaming responses. */
  enableStreaming: z.boolean().optional(),
  /** When true, allow escalating to a human operator. */
  enableHumanEscalation: z.boolean().optional(),
});

// ─────────────────────────────────────────────────────────────
// MCP servers — shape mirrors core MCPServerConfig
// ─────────────────────────────────────────────────────────────

const RuntimeMCPServerConfigSchema = z
  .object({
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    url: z.string().optional(),
    headers: z.record(z.string()).optional(),
    enabled: z.boolean().default(true),
  })
  .refine(
    (data) => data.command !== undefined || data.url !== undefined,
    { message: "Must specify either 'command' (stdio) or 'url' (HTTP/SSE)" }
  );

// ─────────────────────────────────────────────────────────────
// Top-level document
// ─────────────────────────────────────────────────────────────

export const RuntimeConfigSchema = z.object({
  /** Semantic version string published by Kai. Jiva validates presence. */
  runtimeConfigVersion: z.string(),
  model: RuntimeModelConfigSchema,
  prompts: RuntimePromptsSchema,
  runtime: RuntimeSettingsSchema.optional(),
  voice: VoiceConfigSchema.optional(),
  features: FeatureFlagsSchema.optional(),
  mcpServers: z.record(RuntimeMCPServerConfigSchema).optional(),
});

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;
export type RuntimeModelConfig = z.infer<typeof RuntimeModelConfigSchema>;
export type RuntimePrompts = z.infer<typeof RuntimePromptsSchema>;
export type RuntimeTimeout = z.infer<typeof RuntimeTimeoutSchema>;
export type RuntimeIterationLimits = z.infer<typeof RuntimeIterationLimitsSchema>;
export type RuntimeRetryPolicy = z.infer<typeof RuntimeRetryPolicySchema>;
export type RuntimeSettings = z.infer<typeof RuntimeSettingsSchema>;
export type FeatureFlags = z.infer<typeof FeatureFlagsSchema>;
export type RuntimeMCPServerConfig = z.infer<typeof RuntimeMCPServerConfigSchema>;
