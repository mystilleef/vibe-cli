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

/** Options for calling the Anthropic Messages API. */
export interface AnthropicCallOptions {
  model: string;
  compiledPrompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  baseUrl?: string;
  apiKey?: string;
  authToken?: string;
  version?: string;
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
export function resolveAnthropicConfig(
  overrides: Partial<AnthropicConfig> = {},
): AnthropicConfig {
  const baseUrl = (
    overrides.baseUrl ??
    process.env["ANTHROPIC_BASE_URL"] ??
    "https://api.anthropic.com"
  ).replace(/\/+$/, "");
  const apiKey = overrides.apiKey ?? process.env["ANTHROPIC_API_KEY"];
  const authToken = overrides.authToken ?? process.env["ANTHROPIC_AUTH_TOKEN"];
  const version =
    overrides.version ?? process.env["ANTHROPIC_VERSION"] ?? "2023-06-01";

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
    headers["authorization"] = `Bearer ${authToken}`;
  }
  return headers;
}

// ── Anthropic response helpers ────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getStringProperty(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const property = value?.[key];
  return typeof property === "string" ? property : undefined;
}

function isAnthropicTextBlock(
  value: unknown,
): value is { type: "text"; text: string } {
  return (
    isRecord(value) &&
    value["type"] === "text" &&
    typeof value["text"] === "string"
  );
}

/**
 * Throw a descriptive error for a failed Anthropic API response.
 *
 * Includes the Anthropic request ID when available and maps common status codes
 * (401/403 → auth error, 429 → rate limit with retry-after) to specific messages.
 */
function throwAnthropicError(
  response: Response,
  parsedObject: Record<string, unknown> | undefined,
  rawText: string,
): never {
  const requestId =
    response.headers.get("anthropic-request-id") ||
    response.headers.get("x-request-id");
  const suffix = requestId ? ` (request id: ${requestId})` : "";
  const errorObject = isRecord(parsedObject?.["error"])
    ? parsedObject["error"]
    : undefined;
  const msg =
    getStringProperty(errorObject, "message") ??
    getStringProperty(parsedObject, "message") ??
    rawText.trim();

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `Anthropic auth failed (${response.status})${suffix}. Check ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN.`,
    );
  }
  if (response.status === 429) {
    const retry = response.headers.get("retry-after");
    throw new Error(
      `Anthropic rate limited (429)${suffix}.${retry ? ` Retry after ${retry}s.` : ""}`,
    );
  }
  throw new Error(
    `Anthropic error ${response.status}${suffix}. ${msg ?? ""}`.trim(),
  );
}

function extractAnthropicText(
  parsedObject: Record<string, unknown> | undefined,
): string {
  const content = Array.isArray(parsedObject?.["content"])
    ? parsedObject["content"]
    : [];
  const text = content.find(isAnthropicTextBlock)?.text;
  return (
    text ??
    getStringProperty(isRecord(content[0]) ? content[0] : undefined, "text") ??
    ""
  );
}

/**
 * Call the Anthropic Messages API directly via fetch.
 *
 * Uses `resolveAnthropicConfig` for base URL and auth, and `buildAnthropicHeaders`
 * for the required headers. System prompt is passed as a top-level field, not
 * embedded in the user message. Throws on non-2xx responses.
 */
export async function callAnthropic({
  model,
  compiledPrompt,
  systemPrompt,
  maxTokens = 1024,
  temperature = 0.2,
  baseUrl,
  apiKey,
  authToken,
  version,
}: AnthropicCallOptions): Promise<string> {
  const config = resolveAnthropicConfig({
    ...(baseUrl !== undefined && { baseUrl }),
    ...(apiKey !== undefined && { apiKey }),
    ...(authToken !== undefined && { authToken }),
    ...(version !== undefined && { version }),
  });
  const {
    baseUrl: resolvedBaseUrl,
    apiKey: resolvedApiKey,
    authToken: resolvedAuthToken,
    version: resolvedVersion,
  } = config;
  const headers = buildAnthropicHeaders({
    version: resolvedVersion,
    ...(resolvedApiKey !== undefined && { apiKey: resolvedApiKey }),
    ...(resolvedAuthToken !== undefined && { authToken: resolvedAuthToken }),
  });
  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    temperature,
    messages: [{ role: "user", content: compiledPrompt }],
  };
  if (systemPrompt) body["system"] = systemPrompt;

  const response = await fetch(`${resolvedBaseUrl}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const rawText = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    parsed = undefined;
  }
  const parsedObject = isRecord(parsed) ? parsed : undefined;

  if (!response.ok) {
    throwAnthropicError(response, parsedObject, rawText);
  }
  return extractAnthropicText(parsedObject);
}
