/**
 * RuntimeConfigLoader — fetches and validates the runtime-config.json Kai
 * publishes to GCS.
 *
 * URI contract: gs://kai-jiva-state-dev/runtime/organizations/{organizationId}/agents/{agentId}/runtime-config.json
 *
 * Loads the raw document, parses it as JSON, and validates it against the
 * RuntimeConfigSchema. Returns a strongly-typed RuntimeConfig or throws a
 * RuntimeConfigError with a structured message (validation failures include
 * Zod's issue list).
 */

import { Storage } from '@google-cloud/storage';
import { RuntimeConfig, RuntimeConfigSchema } from './types.js';
import { RuntimeConfigError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/** Parsed form of a gs:// URI. */
export interface GcsUriParts {
  bucket: string;
  object: string;
}

/**
 * Parse a `gs://bucket/path/to/object.json` URI into bucket + object parts.
 * Throws RuntimeConfigError for any other scheme or malformed URI.
 */
export function parseGcsUri(uri: string): GcsUriParts {
  const match = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match) {
    throw new RuntimeConfigError(`Invalid runtime config URI (expected gs://bucket/object): ${uri}`);
  }
  return { bucket: match[1], object: match[2] };
}

export class RuntimeConfigLoader {
  /**
   * Load and validate a runtime config from a gs:// URI.
   * Each call re-downloads from GCS — caching is handled by RuntimeConfigCache.
   */
  async loadFromUri(uri: string): Promise<RuntimeConfig> {
    const { bucket, object } = parseGcsUri(uri);
    return this.loadFromGcs(bucket, object);
  }

  /**
   * Download the object from GCS, parse as JSON, validate against the schema.
   * Uses Application Default Credentials unless JIVA_GCP_PROJECT /
   * JIVA_GCP_KEY_FILE are set (same conventions as the storage layer).
   */
  async loadFromGcs(bucket: string, object: string): Promise<RuntimeConfig> {
    const downloadStartedAt = Date.now();
    logger.info('runtime_config.download_started', { bucket, object });

    const storageOptions: { projectId?: string; keyFilename?: string } = {};
    if (process.env.JIVA_GCP_PROJECT) storageOptions.projectId = process.env.JIVA_GCP_PROJECT;
    if (process.env.JIVA_GCP_KEY_FILE) storageOptions.keyFilename = process.env.JIVA_GCP_KEY_FILE;

    const storage = new Storage(storageOptions);
    const file = storage.bucket(bucket).file(object);

    let raw: string;
    let sizeBytes = 0;
    try {
      const [content] = await file.download();
      raw = content.toString('utf-8');
      sizeBytes = content.length;
    } catch (error) {
      throw new RuntimeConfigError(
        `Failed to download runtime config gs://${bucket}/${object}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Best-effort metadata fetch for observability — never breaks the load.
    let generation: string | number | undefined;
    try {
      const [metadata] = await file.getMetadata();
      generation = metadata.generation;
    } catch {
      // Metadata is best-effort; generation simply stays undefined.
    }

    logger.info('runtime_config.download_completed', {
      bucket,
      object,
      generation: generation !== undefined ? String(generation) : undefined,
      sizeBytes,
      durationMs: Date.now() - downloadStartedAt,
    });

    return this.parse(raw);
  }

  /**
   * Parse raw JSON text into a validated RuntimeConfig.
   * Exposed separately so callers (tests, CLI) can validate documents directly.
   */
  parse(raw: string): RuntimeConfig {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (error) {
      throw new RuntimeConfigError(
        `Runtime config is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const result = RuntimeConfigSchema.safeParse(json);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ');
      logger.error('runtime_config.validation_failed', { issues });
      throw new RuntimeConfigError(`Runtime config validation failed: ${issues}`);
    }

    const config = normalizeRuntime(result.data);
    logger.info('runtime_config.validation_success', {
      runtimeConfigVersion: config.runtimeConfigVersion,
      provider: config.model?.provider,
      model: config.model?.model,
      timeout: typeof config.runtime?.timeout === 'number' ? config.runtime.timeout : undefined,
      maxIterations: typeof config.runtime?.iterationLimits === 'number' ? config.runtime.iterationLimits : undefined,
      featureFlags: config.features ?? undefined,
    });
    return config;
  }
}

/**
 * Normalize the runtime settings block into a canonical form so downstream
 * consumers (AgentSession) receive a consistent API regardless of whether Kai
 * published the current scalar formats or an older object-based format:
 *   timeout:         number (ms)              | legacy { seconds }  → number (ms)
 *   iterationLimits: number                   | legacy { maxIterations } → number
 *   retryPolicy:     object | null            → object | undefined
 */
function normalizeRuntime(config: RuntimeConfig): RuntimeConfig {
  if (!config.runtime) return config;
  const runtime = { ...config.runtime };

  if (runtime.timeout !== undefined && typeof runtime.timeout !== 'number') {
    runtime.timeout = runtime.timeout.seconds !== undefined ? runtime.timeout.seconds * 1000 : undefined;
  }

  if (runtime.iterationLimits !== undefined && typeof runtime.iterationLimits !== 'number') {
    runtime.iterationLimits = runtime.iterationLimits.maxIterations;
  }

  if (runtime.retryPolicy === null) {
    runtime.retryPolicy = undefined;
  }

  return { ...config, runtime };
}

export const runtimeConfigLoader = new RuntimeConfigLoader();
