import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getDataRoot } from "./db-core.js";

export const SETTINGS_FILE_MISSING_ERROR =
  "No settings found. Copy settings.example.json to ~/.vibe-cli/settings.json";

export const SUPPORTED_PROVIDER_SPECS = [
  "openai",
  "anthropic",
  "gemini",
] as const;

export type ProviderSpec = (typeof SUPPORTED_PROVIDER_SPECS)[number];

export interface ProviderSettings {
  provider: string;
  model?: string;
  maxAttempts?: number;
  useLearningHistory?: boolean;
  providers: ProviderSettingsEntry[];
}

export interface ProviderSettingsEntry {
  name: string;
  spec: ProviderSpec;
  envVar: string;
  defaultModel?: string;
  baseUrl?: string;
  apiVersion?: string;
  authTokenEnvVar?: string;
  /** Pin or suppress temperature for this provider. `null` omits it entirely. */
  temperature?: number | null;
}

type RawObject = Record<string, unknown>;

function getSettingsPath(): string {
  return join(getDataRoot(), "settings.json");
}

export function loadProviderSettings(): ProviderSettings {
  const settingsPath = getSettingsPath();
  if (!existsSync(settingsPath)) {
    throw new Error(SETTINGS_FILE_MISSING_ERROR);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Malformed JSON in settings.json: ${error.message}`);
    }
    throw error;
  }

  return validateProviderSettings(parsed);
}

export function resolveProviderEntry(
  settings: ProviderSettings,
  providerOverride?: string,
): ProviderSettingsEntry {
  const providerName = providerOverride ?? settings.provider;
  const provider = settings.providers.find(({ name }) => name === providerName);
  if (!provider) {
    throw new Error(`Provider '${providerName}' not found in settings.json`);
  }
  return provider;
}

function validateProviderSettings(value: unknown): ProviderSettings {
  const root = asObject(value, "settings.json");
  const provider = requiredString(
    root["provider"],
    "provider not set in settings.json",
  );
  const model = optionalString(root["model"], "settings.json model");
  const maxAttempts = optionalPositiveInt(root["maxAttempts"], "maxAttempts");
  const useLearningHistory = optionalBoolean(
    root["useLearningHistory"],
    "useLearningHistory",
  );
  const providers = validateProviders(root["providers"]);

  return {
    provider,
    providers,
    ...(model !== undefined && { model }),
    ...(maxAttempts !== undefined && { maxAttempts }),
    ...(useLearningHistory !== undefined && { useLearningHistory }),
  };
}

function validateProviders(value: unknown): ProviderSettingsEntry[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("settings.json providers must not be empty");
  }

  const seen = new Set<string>();
  return value.map((providerValue, index) => {
    const provider = validateProviderEntry(providerValue, index);
    if (seen.has(provider.name)) {
      throw new Error(
        `Duplicate provider name '${provider.name}' in settings.json`,
      );
    }
    seen.add(provider.name);
    return provider;
  });
}

function validateProviderEntry(
  value: unknown,
  index: number,
): ProviderSettingsEntry {
  const provider = asObject(value, `providers[${index}]`);
  const name = requiredString(
    provider["name"],
    `providers[${index}].name must be a non-empty string in settings.json`,
  );
  const spec = validateProviderSpec(provider["spec"], name);
  const envVar = requiredString(
    provider["envVar"],
    `Provider '${name}' envVar must be a non-empty string in settings.json`,
  );
  const defaultModel = optionalString(
    provider["defaultModel"],
    `${name}.defaultModel`,
  );
  const baseUrl = optionalString(provider["baseUrl"], `${name}.baseUrl`);
  const apiVersion = optionalString(
    provider["apiVersion"],
    `${name}.apiVersion`,
  );
  const authTokenEnvVar = optionalString(
    provider["authTokenEnvVar"],
    `${name}.authTokenEnvVar`,
  );
  const temperature = optionalNullableNumber(
    provider["temperature"],
    `${name}.temperature`,
  );

  if (spec === "openai" && baseUrl === undefined) {
    throw new Error(
      `Provider '${name}' baseUrl is required for openai spec in settings.json`,
    );
  }

  return {
    name,
    spec,
    envVar,
    ...(defaultModel !== undefined && { defaultModel }),
    ...(baseUrl !== undefined && { baseUrl }),
    ...(apiVersion !== undefined && { apiVersion }),
    ...(authTokenEnvVar !== undefined && { authTokenEnvVar }),
    ...(temperature !== undefined && { temperature }),
  };
}

function validateProviderSpec(
  value: unknown,
  providerName: string,
): ProviderSpec {
  if (
    typeof value === "string" &&
    SUPPORTED_PROVIDER_SPECS.includes(value as ProviderSpec)
  ) {
    return value as ProviderSpec;
  }

  throw new Error(
    `Provider '${providerName}' has unsupported spec '${String(value)}'. Valid values: ${SUPPORTED_PROVIDER_SPECS.join(", ")}`,
  );
}

function asObject(value: unknown, label: string): RawObject {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as RawObject;
  }
  throw new Error(`${label} must be an object`);
}

function requiredString(value: unknown, message: string): string {
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }
  throw new Error(message);
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }
  throw new Error(`${label} must be a non-empty string in settings.json`);
}

function optionalPositiveInt(
  value: unknown,
  label: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) {
    return value;
  }
  throw new Error(`${label} must be a positive integer in settings.json`);
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  throw new Error(`${label} must be a boolean in settings.json`);
}

function optionalNullableNumber(
  value: unknown,
  label: string,
): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`${label} must be a finite number or null in settings.json`);
}
