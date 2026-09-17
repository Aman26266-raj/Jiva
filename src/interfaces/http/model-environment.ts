/**
 * Server-owned model connection settings.
 *
 * These values are secrets/infrastructure settings and must never be included
 * in Kai's GCS runtime configuration. Kai publishes only provider/model names;
 * Jiva verifies that they match this environment before starting a session.
 */
export interface JivaModelEnvironment {
  provider: string;
  endpoint: string;
  model: string;
  apiKey: string;
}

const MODEL_ENVIRONMENT_VARIABLES = {
  provider: 'JIVA_MODEL_PROVIDER',
  endpoint: 'JIVA_MODEL_BASE_URL',
  model: 'JIVA_MODEL_NAME',
  apiKey: 'JIVA_MODEL_API_KEY',
} as const;

export function resolveJivaModelEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): JivaModelEnvironment {
  const values = Object.fromEntries(
    Object.entries(MODEL_ENVIRONMENT_VARIABLES).map(([key, name]) => [key, environment[name]?.trim() ?? '']),
  ) as unknown as JivaModelEnvironment;

  const missing = Object.entries(MODEL_ENVIRONMENT_VARIABLES)
    .filter(([key]) => !values[key as keyof JivaModelEnvironment])
    .map(([, name]) => name);

  if (missing.length > 0) {
    throw new Error(`Missing required model environment variables: ${missing.join(', ')}`);
  }

  return values;
}

export function assertRuntimeModelMatchesEnvironment(
  runtimeModel: { provider: string; model: string },
  environment: JivaModelEnvironment,
): void {
  if (runtimeModel.provider.toLowerCase() !== environment.provider.toLowerCase()) {
    throw new Error(
      `Runtime model provider '${runtimeModel.provider}' does not match JIVA_MODEL_PROVIDER '${environment.provider}'`,
    );
  }
  if (runtimeModel.model !== environment.model) {
    throw new Error(
      `Runtime model '${runtimeModel.model}' does not match JIVA_MODEL_NAME '${environment.model}'`,
    );
  }
}
