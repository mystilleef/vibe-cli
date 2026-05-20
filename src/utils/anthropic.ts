/** Resolved Anthropic API connection parameters sourced from environment variables. */
export interface AnthropicConfig {
  /** Base URL with trailing slashes stripped; defaults to `https://api.anthropic.com`. */
  baseUrl: string;
  /** API key from `ANTHROPIC_API_KEY`; mutually exclusive with `authToken`. */
  apiKey?: string;
  /** OAuth bearer token from `ANTHROPIC_AUTH_TOKEN`; mutually exclusive with `apiKey`. */
  authToken?: string;
  /** Anthropic API version header; defaults to `2023-06-01`. */
  version: string;
}

/** Subset of config consumed by `buildAnthropicHeaders`. */
export interface AnthropicHeaderInput {
  apiKey?: string;
  authToken?: string;
  version: string;
}

/**
 * Build an `AnthropicConfig` from environment variables.
 *
 * Resolution order:
 * - Base URL: `ANTHROPIC_BASE_URL` (trailing slashes stripped) → `https://api.anthropic.com`.
 * - Auth: `ANTHROPIC_API_KEY` preferred; falls back to `ANTHROPIC_AUTH_TOKEN`.
 * - Version: `ANTHROPIC_VERSION` → `2023-06-01`.
 *
 * Throws when neither `ANTHROPIC_API_KEY` nor `ANTHROPIC_AUTH_TOKEN` is set.
 */
export function resolveAnthropicConfig(): AnthropicConfig {
  const baseUrl =
    process.env.ANTHROPIC_BASE_URL?.replace(/\/+$/, "") ||
    "https://api.anthropic.com";
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const version = process.env.ANTHROPIC_VERSION || "2023-06-01";

  if (!apiKey && !authToken) {
    throw new Error(
      'Anthropic configuration error: set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN when using provider "anthropic".',
    );
  }

  return {
    baseUrl,
    version,
    ...(apiKey !== undefined && { apiKey }),
    ...(authToken !== undefined && { authToken }),
  };
}

/**
 * Construct HTTP headers for an Anthropic API request.
 *
 * Sets `content-type`, `anthropic-version`, and authentication.
 * When `apiKey` is present, uses `x-api-key`; otherwise falls back to
 * `Authorization: Bearer` with `authToken`.
 */
export function buildAnthropicHeaders({
  apiKey,
  authToken,
  version,
}: AnthropicHeaderInput): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": version,
  };
  if (apiKey) {
    headers["x-api-key"] = apiKey;
  } else if (authToken) {
    headers.authorization = `Bearer ${authToken}`;
  }
  return headers;
}
