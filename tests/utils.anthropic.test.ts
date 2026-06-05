import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  buildAnthropicHeaders,
  resolveAnthropicConfig,
} from "../src/utils/anthropic";

const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_VERSION",
] as const;

const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> =
  {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("resolveAnthropicConfig", () => {
  test("throws when neither ANTHROPIC_API_KEY nor ANTHROPIC_AUTH_TOKEN is set", () => {
    expect(() => resolveAnthropicConfig()).toThrow(
      /ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN/,
    );
  });

  test("uses ANTHROPIC_API_KEY and default base URL and version", () => {
    process.env.ANTHROPIC_API_KEY = "key-123";
    const cfg = resolveAnthropicConfig();
    expect(cfg.apiKey).toBe("key-123");
    expect(cfg.authToken).toBeUndefined();
    expect(cfg.baseUrl).toBe("https://api.anthropic.com");
    expect(cfg.version).toBe("2023-06-01");
  });

  test("uses ANTHROPIC_AUTH_TOKEN when API key absent", () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "tok-abc";
    const cfg = resolveAnthropicConfig();
    expect(cfg.authToken).toBe("tok-abc");
    expect(cfg.apiKey).toBeUndefined();
  });

  test("trims trailing slashes from ANTHROPIC_BASE_URL", () => {
    process.env.ANTHROPIC_API_KEY = "k";
    process.env.ANTHROPIC_BASE_URL = "https://proxy.example.com///";
    const cfg = resolveAnthropicConfig();
    expect(cfg.baseUrl).toBe("https://proxy.example.com");
  });

  test("respects custom ANTHROPIC_VERSION", () => {
    process.env.ANTHROPIC_API_KEY = "k";
    process.env.ANTHROPIC_VERSION = "2024-01-01";
    const cfg = resolveAnthropicConfig();
    expect(cfg.version).toBe("2024-01-01");
  });

  test("prefers ANTHROPIC_API_KEY over ANTHROPIC_AUTH_TOKEN when both set", () => {
    process.env.ANTHROPIC_API_KEY = "key-first";
    process.env.ANTHROPIC_AUTH_TOKEN = "tok-second";
    const cfg = resolveAnthropicConfig();
    expect(cfg.apiKey).toBe("key-first");
    expect(cfg.authToken).toBe("tok-second");
  });
});

describe("buildAnthropicHeaders", () => {
  test("sets x-api-key when apiKey present", () => {
    const h = buildAnthropicHeaders({
      apiKey: "my-key",
      version: "2023-06-01",
    });
    expect(h["x-api-key"]).toBe("my-key");
    expect(h["anthropic-version"]).toBe("2023-06-01");
    expect(h["content-type"]).toBe("application/json");
    expect(h.authorization).toBeUndefined();
  });

  test("sets Bearer authorization when authToken present and apiKey absent", () => {
    const h = buildAnthropicHeaders({
      authToken: "tok",
      version: "2023-06-01",
    });
    expect(h.authorization).toBe("Bearer tok");
    expect(h["x-api-key"]).toBeUndefined();
  });

  test("emits only content-type and anthropic-version when neither key present", () => {
    const h = buildAnthropicHeaders({ version: "2023-06-01" });
    expect(Object.keys(h)).toEqual(
      expect.arrayContaining(["content-type", "anthropic-version"]),
    );
    expect(h["x-api-key"]).toBeUndefined();
    expect(h.authorization).toBeUndefined();
  });

  test("prefers x-api-key over Bearer when both apiKey and authToken present", () => {
    const h = buildAnthropicHeaders({
      apiKey: "key",
      authToken: "tok",
      version: "2023-06-01",
    });
    expect(h["x-api-key"]).toBe("key");
    expect(h.authorization).toBeUndefined();
  });
});
