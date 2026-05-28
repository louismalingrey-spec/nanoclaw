/**
 * Claude provider container config.
 *
 * Two auth modes are supported:
 *
 *   1. Direct env-var auth (VPS / single-tenant). When `ANTHROPIC_API_KEY`
 *      is set in the daemon's .env, the key is forwarded to the container
 *      as-is. Used with `ANTHROPIC_BASE_URL=https://openrouter.ai/api/v1`
 *      (OpenRouter routing) on the Hetzner VPS where OneCLI is not deployed.
 *      The container-runner skips the OneCLI gateway requirement when this
 *      mode is active — see src/container-runner.ts.
 *
 *   2. OneCLI proxy auth (legacy Mac install). The real auth token never
 *      enters the container. Setup creates a OneCLI generic secret so the
 *      proxy rewrites the Authorization header on the wire. The container
 *      gets ANTHROPIC_AUTH_TOKEN=placeholder which OneCLI overwrites.
 *
 * Mode is chosen by which key is present in .env:
 *   - ANTHROPIC_API_KEY set         → direct env-var auth
 *   - ANTHROPIC_BASE_URL only       → OneCLI proxy auth (legacy)
 *   - neither                       → no provider env contribution
 */
import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

registerProviderContainerConfig('claude', () => {
  // Mirror src/config.ts pattern: process.env wins, .env file is the fallback.
  // process.env is how docker compose passes vars via its `environment:` block
  // (no .env file lands at /app/.env inside the container).
  // Forwarded model-related env. The DEFAULT_*_MODEL and CUSTOM_MODEL_OPTION
  // overrides let the Claude Code CLI accept OpenRouter-prefixed slugs
  // (e.g. "anthropic/claude-sonnet-4.6") that would otherwise be rejected
  // by the CLI's hardcoded allowlist. See
  // deploy/hetzner-stack/nanoclaw/docker-compose.yml for the rationale.
  const MODEL_VARS = [
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_CUSTOM_MODEL_OPTION',
    'ANTHROPIC_CUSTOM_MODEL_OPTION_NAME',
    'ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION',
    'ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES',
  ] as const;

  const dotenv = readEnvFile(['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', ...MODEL_VARS]);
  const baseUrl = process.env.ANTHROPIC_BASE_URL || dotenv.ANTHROPIC_BASE_URL;
  const apiKey = process.env.ANTHROPIC_API_KEY || dotenv.ANTHROPIC_API_KEY;
  const env: Record<string, string> = {};

  if (baseUrl) {
    env.ANTHROPIC_BASE_URL = baseUrl;
  }

  if (apiKey) {
    // Direct env-var auth — no OneCLI proxy involved.
    env.ANTHROPIC_API_KEY = apiKey;
  } else if (baseUrl) {
    // OneCLI proxy auth — placeholder gets overwritten on the wire.
    env.ANTHROPIC_AUTH_TOKEN = 'placeholder';
  }

  for (const key of MODEL_VARS) {
    const value = process.env[key] || dotenv[key];
    if (value) {
      env[key] = value;
    }
  }

  return { env };
});
