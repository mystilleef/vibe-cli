import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  loadProviderSettings,
  resolveProviderEntry,
  SETTINGS_FILE_MISSING_ERROR,
  SUPPORTED_PROVIDER_SPECS,
} from "../src/utils/settings.js";
import { mockSettings } from "./helpers/mockSettings.js";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome.js";

let tempHome: TempHomeContext;

async function writeSettings(value: unknown): Promise<void> {
  await mkdir(tempHome.dataRoot, { recursive: true });
  await writeFile(
    join(tempHome.dataRoot, "settings.json"),
    typeof value === "string" ? value : JSON.stringify(value, null, 2),
  );
}

/** Settings fixture using test-specific provider names for validation tests. */
function validSettings(overrides: Record<string, unknown> = {}) {
  return mockSettings({
    model: "settings-model",
    providers: [
      { name: "gemini", spec: "gemini", envVar: "GEMINI_API_KEY" },
      {
        name: "openai-compatible",
        spec: "openai",
        envVar: "OPENAI_COMPATIBLE_API_KEY",
        baseUrl: "https://api.example.com/v1",
        defaultModel: "compat-model",
      },
      {
        name: "anthropic",
        spec: "anthropic",
        envVar: "ANTHROPIC_API_KEY",
        defaultModel: "claude-haiku-4-5-20251001",
        baseUrl: "https://api.anthropic.com",
        apiVersion: "2023-06-01",
        authTokenEnvVar: "ANTHROPIC_AUTH_TOKEN",
      },
    ],
    ...overrides,
  });
}

beforeEach(async () => {
  tempHome = await createTempHome();
});

afterEach(async () => {
  await tempHome.cleanup();
});

describe("loadProviderSettings", () => {
  test("loads typed provider settings without reading API token values", async () => {
    process.env["GEMINI_API_KEY"] = "secret-before";
    await writeSettings(validSettings());
    process.env["GEMINI_API_KEY"] = "secret-after";

    const settings = loadProviderSettings();

    expect(settings.provider).toBe("gemini");
    expect(settings.model).toBe("settings-model");
    expect(settings.providers).toHaveLength(3);
    expect(settings.providers[0]).toEqual({
      name: "gemini",
      spec: "gemini",
      envVar: "GEMINI_API_KEY",
    });
    expect(JSON.stringify(settings)).not.toContain("secret-after");
    delete process.env["GEMINI_API_KEY"];
  });

  test("preserves OpenRouter without a default model", async () => {
    await writeSettings(
      validSettings({
        provider: "openrouter",
        providers: [
          {
            name: "openrouter",
            spec: "openai",
            envVar: "OPENROUTER_API_KEY",
            baseUrl: "https://openrouter.ai/api/v1",
          },
        ],
      }),
    );

    const settings = loadProviderSettings();

    expect(settings.providers[0]?.defaultModel).toBeUndefined();
  });

  test("preserves custom Qwen DashScope env-var naming", async () => {
    await writeSettings(
      validSettings({
        provider: "qwen",
        providers: [
          {
            name: "qwen",
            spec: "openai",
            envVar: "DASHSCOPE_API_KEY",
            baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            defaultModel: "qwen-plus",
          },
        ],
      }),
    );

    expect(loadProviderSettings().providers[0]?.envVar).toBe(
      "DASHSCOPE_API_KEY",
    );
  });

  test("preserves Anthropic optional metadata", async () => {
    await writeSettings(validSettings({ provider: "anthropic" }));

    const anthropic = resolveProviderEntry(loadProviderSettings());

    expect(anthropic).toMatchObject({
      name: "anthropic",
      spec: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiVersion: "2023-06-01",
      authTokenEnvVar: "ANTHROPIC_AUTH_TOKEN",
    });
  });

  test("repository settings example validates and contains no secrets", async () => {
    const example = await readFile("settings.example.json", "utf8");

    expect(example).not.toContain("<key>");
    expect(example).not.toContain("secret");

    const parsed = JSON.parse(example) as {
      providers: Array<{ name: string }>;
    };
    await writeSettings(parsed);

    const settings = loadProviderSettings();
    const providerNames = settings.providers.map(({ name }) => name);

    expect(settings.provider).toBe("gemini");
    expect(providerNames).toEqual([
      "gemini",
      "openai",
      "anthropic",
      "openrouter",
      "deepseek",
      "mimo",
      "opencode",
      "opencode-anthropic",
      "qwen-dashscope",
    ]);
    expect(
      settings.providers.find(({ name }) => name === "openrouter")
        ?.defaultModel,
    ).toBeUndefined();
  });

  test("fails when settings file is missing", () => {
    expect(() => loadProviderSettings()).toThrow(SETTINGS_FILE_MISSING_ERROR);
  });

  test("fails on malformed JSON", async () => {
    await writeSettings("{not-json");

    expect(() => loadProviderSettings()).toThrow(
      "Malformed JSON in settings.json:",
    );
  });

  test("rethrows non-SyntaxError file read errors", async () => {
    const settingsPath = join(tempHome.dataRoot, "settings.json");
    await mkdir(tempHome.dataRoot, { recursive: true });
    await writeFile(settingsPath, "{}", { mode: 0o644 });
    await chmod(settingsPath, 0o000);

    try {
      expect(() => loadProviderSettings()).toThrow(/EACCES|Permission denied/);
    } finally {
      await chmod(settingsPath, 0o644);
    }
  });

  test("fails when top-level provider is missing", async () => {
    await writeSettings(validSettings({ provider: undefined }));

    expect(() => loadProviderSettings()).toThrow(
      "provider not set in settings.json",
    );
  });

  test("fails when top-level provider is blank", async () => {
    await writeSettings(validSettings({ provider: " " }));

    expect(() => loadProviderSettings()).toThrow(
      "provider not set in settings.json",
    );
  });

  test("fails when top-level model is blank", async () => {
    await writeSettings(validSettings({ model: "" }));

    expect(() => loadProviderSettings()).toThrow(
      "settings.json model must be a non-empty string in settings.json",
    );
  });

  test("fails when providers array is empty", async () => {
    await writeSettings(validSettings({ providers: [] }));

    expect(() => loadProviderSettings()).toThrow(
      "settings.json providers must not be empty",
    );
  });

  test("fails when settings.json root is a JSON string", async () => {
    await writeSettings('"just-a-string"');

    expect(() => loadProviderSettings()).toThrow(
      "settings.json must be an object",
    );
  });

  test("fails when providers key is absent", async () => {
    await writeSettings({ provider: "gemini" });

    expect(() => loadProviderSettings()).toThrow(
      "settings.json providers must not be empty",
    );
  });

  test("fails when providers is null", async () => {
    await writeSettings(validSettings({ providers: null }));

    expect(() => loadProviderSettings()).toThrow(
      "settings.json providers must not be empty",
    );
  });

  test("fails when providers is a string", async () => {
    await writeSettings(validSettings({ providers: "not-array" }));

    expect(() => loadProviderSettings()).toThrow(
      "settings.json providers must not be empty",
    );
  });

  test("fails when providers is an object", async () => {
    await writeSettings(validSettings({ providers: {} }));

    expect(() => loadProviderSettings()).toThrow(
      "settings.json providers must not be empty",
    );
  });

  test("fails when a provider entry is null", async () => {
    await writeSettings(
      validSettings({
        providers: [null],
      }),
    );

    expect(() => loadProviderSettings()).toThrow(
      "providers[0] must be an object",
    );
  });

  test("fails when a provider entry is a number", async () => {
    await writeSettings(
      validSettings({
        providers: [42],
      }),
    );

    expect(() => loadProviderSettings()).toThrow(
      "providers[0] must be an object",
    );
  });

  test("fails when a provider entry is a string", async () => {
    await writeSettings(
      validSettings({
        providers: ["not-object"],
      }),
    );

    expect(() => loadProviderSettings()).toThrow(
      "providers[0] must be an object",
    );
  });

  test("loads useLearningHistory true", async () => {
    await writeSettings(validSettings({ useLearningHistory: true }));

    expect(loadProviderSettings().useLearningHistory).toBe(true);
  });

  test("fails when useLearningHistory is a number", async () => {
    await writeSettings(validSettings({ useLearningHistory: 1 }));

    expect(() => loadProviderSettings()).toThrow(
      "useLearningHistory must be a boolean in settings.json",
    );
  });

  test("fails when useLearningHistory is a string", async () => {
    await writeSettings(validSettings({ useLearningHistory: "yes" }));

    expect(() => loadProviderSettings()).toThrow(
      "useLearningHistory must be a boolean in settings.json",
    );
  });

  test("fails when useLearningHistory is null", async () => {
    await writeSettings(validSettings({ useLearningHistory: null }));

    expect(() => loadProviderSettings()).toThrow(
      "useLearningHistory must be a boolean in settings.json",
    );
  });

  test("loads useLearningHistory false", async () => {
    await writeSettings(validSettings({ useLearningHistory: false }));

    expect(loadProviderSettings().useLearningHistory).toBe(false);
  });

  test("fails when settings.json root is a JSON array", async () => {
    await writeSettings([1, 2, 3]);

    expect(() => loadProviderSettings()).toThrow(
      "settings.json must be an object",
    );
  });

  test("fails when provider names are blank", async () => {
    await writeSettings(
      validSettings({
        providers: [{ name: " ", spec: "gemini", envVar: "GEMINI_API_KEY" }],
      }),
    );

    expect(() => loadProviderSettings()).toThrow(
      "providers[0].name must be a non-empty string in settings.json",
    );
  });

  test("fails when provider names are duplicated", async () => {
    await writeSettings(
      validSettings({
        providers: [
          { name: "gemini", spec: "gemini", envVar: "GEMINI_API_KEY" },
          { name: "gemini", spec: "gemini", envVar: "OTHER_GEMINI_KEY" },
        ],
      }),
    );

    expect(() => loadProviderSettings()).toThrow(
      "Duplicate provider name 'gemini' in settings.json",
    );
  });

  test("fails with offending provider and supported specs for unsupported specs", async () => {
    await writeSettings(
      validSettings({
        providers: [{ name: "bad", spec: "ollama", envVar: "OLLAMA_KEY" }],
      }),
    );

    expect(() => loadProviderSettings()).toThrow(
      `Provider 'bad' has unsupported spec 'ollama'. Valid values: ${SUPPORTED_PROVIDER_SPECS.join(", ")}`,
    );
  });

  test("fails when envVar is blank", async () => {
    await writeSettings(
      validSettings({
        providers: [{ name: "gemini", spec: "gemini", envVar: "" }],
      }),
    );

    expect(() => loadProviderSettings()).toThrow(
      "Provider 'gemini' envVar must be a non-empty string in settings.json",
    );
  });

  test("fails when provider defaultModel is blank", async () => {
    await writeSettings(
      validSettings({
        providers: [
          {
            name: "gemini",
            spec: "gemini",
            envVar: "GEMINI_API_KEY",
            defaultModel: " ",
          },
        ],
      }),
    );

    expect(() => loadProviderSettings()).toThrow(
      "gemini.defaultModel must be a non-empty string in settings.json",
    );
  });

  test("fails when OpenAI-compatible provider omits baseUrl", async () => {
    await writeSettings(
      validSettings({
        provider: "openrouter",
        providers: [
          { name: "openrouter", spec: "openai", envVar: "OPENROUTER_API_KEY" },
        ],
      }),
    );

    expect(() => loadProviderSettings()).toThrow(
      "Provider 'openrouter' baseUrl is required for openai spec in settings.json",
    );
  });

  test("fails when provider baseUrl is blank", async () => {
    await writeSettings(
      validSettings({
        providers: [
          {
            name: "openrouter",
            spec: "openai",
            envVar: "OPENROUTER_API_KEY",
            baseUrl: " ",
          },
        ],
      }),
    );

    expect(() => loadProviderSettings()).toThrow(
      "openrouter.baseUrl must be a non-empty string in settings.json",
    );
  });

  test("fails when Anthropic metadata environment variable name is blank", async () => {
    await writeSettings(
      validSettings({
        providers: [
          {
            name: "anthropic",
            spec: "anthropic",
            envVar: "ANTHROPIC_API_KEY",
            authTokenEnvVar: " ",
          },
        ],
      }),
    );

    expect(() => loadProviderSettings()).toThrow(
      "anthropic.authTokenEnvVar must be a non-empty string in settings.json",
    );
  });

  test("fails when provider apiVersion is blank", async () => {
    await writeSettings(
      validSettings({
        providers: [
          {
            name: "anthropic",
            spec: "anthropic",
            envVar: "ANTHROPIC_API_KEY",
            apiVersion: " ",
          },
        ],
      }),
    );

    expect(() => loadProviderSettings()).toThrow(
      "anthropic.apiVersion must be a non-empty string in settings.json",
    );
  });

  test("omits defaultModel when not specified", async () => {
    await writeSettings(
      validSettings({
        providers: [
          { name: "gemini", spec: "gemini", envVar: "GEMINI_API_KEY" },
        ],
      }),
    );

    const settings = loadProviderSettings();

    expect(settings.providers[0]?.defaultModel).toBeUndefined();
    expect(settings.providers[0]?.baseUrl).toBeUndefined();
    expect(settings.providers[0]?.apiVersion).toBeUndefined();
    expect(settings.providers[0]?.authTokenEnvVar).toBeUndefined();
    expect(settings.providers[0]?.temperature).toBeUndefined();
  });

  test("loads provider temperature when set to a finite number", async () => {
    await writeSettings(
      validSettings({
        providers: [
          {
            name: "gemini",
            spec: "gemini",
            envVar: "GEMINI_API_KEY",
            temperature: 0.7,
          },
        ],
      }),
    );

    expect(loadProviderSettings().providers[0]?.temperature).toBe(0.7);
  });

  test("loads provider temperature when set to zero", async () => {
    await writeSettings(
      validSettings({
        providers: [
          {
            name: "gemini",
            spec: "gemini",
            envVar: "GEMINI_API_KEY",
            temperature: 0,
          },
        ],
      }),
    );

    expect(loadProviderSettings().providers[0]?.temperature).toBe(0);
  });

  test("loads provider temperature null as null", async () => {
    await writeSettings(
      validSettings({
        providers: [
          {
            name: "gemini",
            spec: "gemini",
            envVar: "GEMINI_API_KEY",
            temperature: null,
          },
        ],
      }),
    );

    expect(loadProviderSettings().providers[0]?.temperature).toBeNull();
  });

  test("fails when provider temperature is a string", async () => {
    await writeSettings(
      validSettings({
        providers: [
          {
            name: "gemini",
            spec: "gemini",
            envVar: "GEMINI_API_KEY",
            temperature: "0.7",
          },
        ],
      }),
    );

    expect(() => loadProviderSettings()).toThrow(
      "gemini.temperature must be a finite number or null in settings.json",
    );
  });

  test("fails when provider temperature is boolean", async () => {
    await writeSettings(
      validSettings({
        providers: [
          {
            name: "gemini",
            spec: "gemini",
            envVar: "GEMINI_API_KEY",
            temperature: true,
          },
        ],
      }),
    );

    expect(() => loadProviderSettings()).toThrow(
      "gemini.temperature must be a finite number or null in settings.json",
    );
  });

  test("provider temperature as negative number is accepted", async () => {
    await writeSettings(
      validSettings({
        providers: [
          {
            name: "gemini",
            spec: "gemini",
            envVar: "GEMINI_API_KEY",
            temperature: -0.5,
          },
        ],
      }),
    );

    expect(loadProviderSettings().providers[0]?.temperature).toBe(-0.5);
  });

  test("fails when provider temperature is an object", async () => {
    await writeSettings(
      validSettings({
        providers: [
          {
            name: "gemini",
            spec: "gemini",
            envVar: "GEMINI_API_KEY",
            temperature: { value: 0.5 },
          },
        ],
      }),
    );

    expect(() => loadProviderSettings()).toThrow(
      "gemini.temperature must be a finite number or null in settings.json",
    );
  });

  test("fails when provider temperature is an array", async () => {
    await writeSettings(
      validSettings({
        providers: [
          {
            name: "gemini",
            spec: "gemini",
            envVar: "GEMINI_API_KEY",
            temperature: [0.5],
          },
        ],
      }),
    );

    expect(() => loadProviderSettings()).toThrow(
      "gemini.temperature must be a finite number or null in settings.json",
    );
  });

  test("loads maxAttempts when set to a positive integer", async () => {
    await writeSettings(validSettings({ maxAttempts: 5 }));

    const settings = loadProviderSettings();

    expect(settings.maxAttempts).toBe(5);
  });

  test("omits maxAttempts when not specified", async () => {
    await writeSettings(validSettings());

    const settings = loadProviderSettings();

    expect(settings.maxAttempts).toBeUndefined();
  });

  test("fails when maxAttempts is zero", async () => {
    await writeSettings(validSettings({ maxAttempts: 0 }));

    expect(() => loadProviderSettings()).toThrow(
      "maxAttempts must be a positive integer in settings.json",
    );
  });

  test("fails when maxAttempts is negative", async () => {
    await writeSettings(validSettings({ maxAttempts: -3 }));

    expect(() => loadProviderSettings()).toThrow(
      "maxAttempts must be a positive integer in settings.json",
    );
  });

  test("fails when maxAttempts is a non-integer number", async () => {
    await writeSettings(validSettings({ maxAttempts: 2.5 }));

    expect(() => loadProviderSettings()).toThrow(
      "maxAttempts must be a positive integer in settings.json",
    );
  });

  test("fails when maxAttempts is a string", async () => {
    await writeSettings(validSettings({ maxAttempts: "5" }));

    expect(() => loadProviderSettings()).toThrow(
      "maxAttempts must be a positive integer in settings.json",
    );
  });

  test("fails when maxAttempts is null", async () => {
    await writeSettings(validSettings({ maxAttempts: null }));

    expect(() => loadProviderSettings()).toThrow(
      "maxAttempts must be a positive integer in settings.json",
    );
  });

  test("fails when maxAttempts is a boolean", async () => {
    await writeSettings(validSettings({ maxAttempts: true }));

    expect(() => loadProviderSettings()).toThrow(
      "maxAttempts must be a positive integer in settings.json",
    );
  });

  test("fails when maxAttempts is Infinity", async () => {
    await writeSettings(validSettings({ maxAttempts: Infinity }));

    expect(() => loadProviderSettings()).toThrow(
      "maxAttempts must be a positive integer in settings.json",
    );
  });

  test("fails when maxAttempts is NaN", async () => {
    await writeSettings(validSettings({ maxAttempts: undefined }));
    // Write NaN separately since JSON.stringify(NaN) produces null.
    // The existing test covers the null case; this test covers the
    // explicit null path via the NaN JSON serialization quirk.
    await writeSettings(validSettings({ maxAttempts: NaN }));

    expect(() => loadProviderSettings()).toThrow(
      "maxAttempts must be a positive integer in settings.json",
    );
  });

  test("omits useLearningHistory when not specified", async () => {
    // Build settings without the useLearningHistory key entirely.
    const { useLearningHistory: _, ...withoutLearning } =
      validSettings() as Record<string, unknown> & {
        useLearningHistory?: boolean;
      };
    await writeSettings(withoutLearning);

    expect(loadProviderSettings().useLearningHistory).toBeUndefined();
  });
});

describe("resolveProviderEntry", () => {
  test("resolves top-level provider by default", async () => {
    await writeSettings(validSettings({ provider: "openai-compatible" }));

    expect(resolveProviderEntry(loadProviderSettings()).name).toBe(
      "openai-compatible",
    );
  });

  test("provider override wins over settings provider", async () => {
    await writeSettings(validSettings({ provider: "gemini" }));

    expect(resolveProviderEntry(loadProviderSettings(), "anthropic").name).toBe(
      "anthropic",
    );
  });

  test("fails when selected provider is not configured", async () => {
    await writeSettings(validSettings());

    expect(() =>
      resolveProviderEntry(loadProviderSettings(), "missing"),
    ).toThrow("Provider 'missing' not found in settings.json");
  });
});
