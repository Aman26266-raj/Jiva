/**
 * RuntimeConfigCache — in-memory cache for parsed runtime configs.
 *
 * Keyed by the runtime config URI so every agent session sharing the same URI
 * reuses one validated document instead of re-downloading from GCS.
 *
 * Each entry records:
 *   - config      the parsed, validated RuntimeConfig
 *   - generation  an opaque version stamp for the document
 *   - loadedAt    when the entry was loaded/refreshed
 *
 * Refreshes are explicit — callers decide when to pull a new generation.
 */

import { RuntimeConfig } from './types.js';
import { RuntimeConfigLoader } from './loader.js';
import { logger } from '../utils/logger.js';

export interface CachedRuntimeConfig {
  /** The parsed, validated config. */
  config: RuntimeConfig;
  /**
   * Opaque generation stamp for the document. In GCS this is the object's
   * `generation` metadata; otherwise a content hash of the raw JSON.
   */
  generation: string;
  /** When this entry was loaded or refreshed. */
  loadedAt: Date;
}

interface GcsMetadata {
  generation?: string | number;
}

export class RuntimeConfigCache {
  private entries: Map<string, CachedRuntimeConfig> = new Map();

  constructor(private readonly loader: RuntimeConfigLoader) {}

  /**
   * Load and cache the config for a URI. If already cached, returns the cache
   * entry without re-downloading. Use `refresh` to force a re-download.
   */
  async get(uri: string): Promise<CachedRuntimeConfig> {
    const cached = this.entries.get(uri);
    if (cached) {
      logger.info('runtime_config.cache_hit', { uri, generation: cached.generation, loadedAt: cached.loadedAt });
      return cached;
    }
    logger.info('runtime_config.cache_miss', { uri });
    return this.load(uri);
  }

  /**
   * Force a fresh download for a URI and replace the cached entry.
   * Throws if the load fails; the stale entry is preserved on failure.
   */
  async refresh(uri: string): Promise<CachedRuntimeConfig> {
    logger.debug(`[RuntimeConfigCache] Refreshing: ${uri}`);
    return this.load(uri);
  }

  /**
   * Remove a URI from the cache. Next `get` re-downloads.
   */
  invalidate(uri: string): void {
    this.entries.delete(uri);
    logger.debug(`[RuntimeConfigCache] Invalidated: ${uri}`);
  }

  /** Remove all cached entries. */
  clear(): void {
    this.entries.clear();
  }

  /** True when the URI is currently cached. */
  has(uri: string): boolean {
    return this.entries.has(uri);
  }

  private async load(uri: string): Promise<CachedRuntimeConfig> {
    const config = await this.loader.loadFromUri(uri);

    let generation = String(Date.now());
    try {
      const { parseGcsUri } = await import('./loader.js');
      const { bucket, object } = parseGcsUri(uri);
      const metadata = await this.fetchMetadata(bucket, object);
      if (metadata?.generation !== undefined) {
        generation = String(metadata.generation);
      }
    } catch {
      // Metadata fetch is best-effort; fall back to a timestamp stamp.
    }

    const entry: CachedRuntimeConfig = {
      config,
      generation,
      loadedAt: new Date(),
    };
    this.entries.set(uri, entry);
    logger.info(`[RuntimeConfigCache] Cached ${uri} (generation ${generation})`);
    return entry;
  }

  private async fetchMetadata(bucket: string, object: string): Promise<GcsMetadata | null> {
    try {
      const { Storage } = await import('@google-cloud/storage');
      const storageOptions: { projectId?: string; keyFilename?: string } = {};
      if (process.env.JIVA_GCP_PROJECT) storageOptions.projectId = process.env.JIVA_GCP_PROJECT;
      if (process.env.JIVA_GCP_KEY_FILE) storageOptions.keyFilename = process.env.JIVA_GCP_KEY_FILE;
      const storage = new Storage(storageOptions);
      const [metadata] = await storage.bucket(bucket).file(object).getMetadata();
      return { generation: metadata.generation };
    } catch {
      return null;
    }
  }
}
