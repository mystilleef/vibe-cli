import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  buildAnthropicHeaders,
  callAnthropic,
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

interface FetchCall {
  url: string;
  init: RequestInit;
}

const originalFetch = globalThis.fetch;
const fetchCalls: FetchCall[] = [];

function mockFetch(response: Response): void {
  globalThis.fetch = (async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    fetchCalls.push({ url, init: init ?? {} });
    return response;
  }) as typeof fetch;
}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  fetchCalls.length = 0;
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  globalThis.fetch = originalFetch;
});

describe("resolveAnthropicConfig", () => {
  test("throws when neither ANTHROPIC_API_KEY nor ANTHROPIC_AUTH_TOKEN is set", () => {
    expect(() => resolveAnthropicConfig()).toThrow(
      /ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN/,
    );
  });

  test("uses ANTHROPIC_API_KEY and default base URL and version", () => {
    process.env["ANTHROPIC_API_KEY"] = "key-123";
    const cfg = resolveAnthropicConfig();
    expect(cfg.apiKey).toBe("key-123");
    expect(cfg.authToken).toBeUndefined();
    expect(cfg.baseUrl).toBe("https://api.anthropic.com");
    expect(cfg.version).toBe("2023-06-01");
  });

  test("uses ANTHROPIC_AUTH_TOKEN when API key absent", () => {
    process.env["ANTHROPIC_AUTH_TOKEN"] = "tok-abc";
    const cfg = resolveAnthropicConfig();
    expect(cfg.authToken).toBe("tok-abc");
    expect(cfg.apiKey).toBeUndefined();
  });

  test("trims trailing slashes from ANTHROPIC_BASE_URL", () => {
    process.env["ANTHROPIC_API_KEY"] = "k";
    process.env["ANTHROPIC_BASE_URL"] = "https://proxy.example.com///";
    const cfg = resolveAnthropicConfig();
    expect(cfg.baseUrl).toBe("https://proxy.example.com");
  });

  test("respects custom ANTHROPIC_VERSION", () => {
    process.env["ANTHROPIC_API_KEY"] = "k";
    process.env["ANTHROPIC_VERSION"] = "2024-01-01";
    const cfg = resolveAnthropicConfig();
    expect(cfg.version).toBe("2024-01-01");
  });

  test("prefers ANTHROPIC_API_KEY over ANTHROPIC_AUTH_TOKEN when both set", () => {
    process.env["ANTHROPIC_API_KEY"] = "key-first";
    process.env["ANTHROPIC_AUTH_TOKEN"] = "tok-second";
    const cfg = resolveAnthropicConfig();
    expect(cfg.apiKey).toBe("key-first");
    expect(cfg.authToken).toBe("tok-second");
  });
});

describe("callAnthropic", () => {
  test("uses injected metadata and credentials instead of environment fallbacks", async () => {
    process.env["ANTHROPIC_API_KEY"] = "env-key";
    process.env["ANTHROPIC_BASE_URL"] = "https://env.example";
    process.env["ANTHROPIC_VERSION"] = "env-version";
    mockFetch(Response.json({ content: [{ type: "text", text: "ok" }] }));

    const result = await callAnthropic({
      model: "claude-test",
      compiledPrompt: "prompt",
      apiKey: "injected-key",
      baseUrl: "https://settings.example///",
      version: "settings-version",
    });

    expect(result).toBe("ok");
    expect(fetchCalls[0]?.url).toBe("https://settings.example/v1/messages");
    expect(fetchCalls[0]?.init.headers).toMatchObject({
      "x-api-key": "injected-key",
      "anthropic-version": "settings-version",
    });
  });

  test("uses injected auth token when API key absent", async () => {
    mockFetch(Response.json({ content: [{ type: "text", text: "ok" }] }));

    await callAnthropic({
      model: "claude-test",
      compiledPrompt: "prompt",
      authToken: "injected-token",
    });

    expect(fetchCalls[0]?.init.headers).toMatchObject({
      authorization: "Bearer injected-token",
    });
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
    expect(h["authorization"]).toBeUndefined();
  });

  test("sets Bearer authorization when authToken present and apiKey absent", () => {
    const h = buildAnthropicHeaders({
      authToken: "tok",
      version: "2023-06-01",
    });
    expect(h["authorization"]).toBe("Bearer tok");
    expect(h["x-api-key"]).toBeUndefined();
  });

  test("emits only content-type and anthropic-version when neither key present", () => {
    const h = buildAnthropicHeaders({ version: "2023-06-01" });
    expect(Object.keys(h)).toEqual(
      expect.arrayContaining(["content-type", "anthropic-version"]),
    );
    expect(h["x-api-key"]).toBeUndefined();
    expect(h["authorization"]).toBeUndefined();
  });

  test("prefers x-api-key over Bearer when both apiKey and authToken present", () => {
    const h = buildAnthropicHeaders({
      apiKey: "key",
      authToken: "tok",
      version: "2023-06-01",
    });
    expect(h["x-api-key"]).toBe("key");
    expect(h["authorization"]).toBeUndefined();
  });
});

describe("callAnthropic error handling", () => {
  test("throws auth error on 401 response", async () => {
    mockFetch(
      new Response(JSON.stringify({ error: { message: "invalid key" } }), {
        status: 401,
        headers: { "anthropic-request-id": "req-abc" },
      }),
    );

    await expect(
      callAnthropic({
        model: "claude-test",
        compiledPrompt: "prompt",
        apiKey: "bad-key",
      }),
    ).rejects.toThrow(
      "Anthropic auth failed (401) (request id: req-abc). Check ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN.",
    );
  });

  test("throws auth error on 403 response", async () => {
    mockFetch(
      new Response(JSON.stringify({ error: { message: "forbidden" } }), {
        status: 403,
      }),
    );

    await expect(
      callAnthropic({
        model: "claude-test",
        compiledPrompt: "prompt",
        apiKey: "key",
      }),
    ).rejects.toThrow("Anthropic auth failed (403)");
  });

  test("throws rate limit error with retry-after on 429 response", async () => {
    mockFetch(
      new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "retry-after": "30" },
      }),
    );

    await expect(
      callAnthropic({
        model: "claude-test",
        compiledPrompt: "prompt",
        apiKey: "key",
      }),
    ).rejects.toThrow("Anthropic rate limited (429). Retry after 30s.");
  });

  test("throws rate limit error without retry-after on 429 response", async () => {
    mockFetch(
      new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
      }),
    );

    await expect(
      callAnthropic({
        model: "claude-test",
        compiledPrompt: "prompt",
        apiKey: "key",
      }),
    ).rejects.toThrow("Anthropic rate limited (429)");
  });

  test("throws generic error with message from response body", async () => {
    mockFetch(
      new Response(
        JSON.stringify({ error: { message: "server overloaded" } }),
        { status: 503, headers: { "x-request-id": "req-xyz" } },
      ),
    );

    await expect(
      callAnthropic({
        model: "claude-test",
        compiledPrompt: "prompt",
        apiKey: "key",
      }),
    ).rejects.toThrow(
      "Anthropic error 503 (request id: req-xyz). server overloaded",
    );
  });

  test("falls back to top-level message when error.message absent", async () => {
    mockFetch(
      new Response(JSON.stringify({ message: "top-level message" }), {
        status: 500,
      }),
    );

    await expect(
      callAnthropic({
        model: "claude-test",
        compiledPrompt: "prompt",
        apiKey: "key",
      }),
    ).rejects.toThrow("Anthropic error 500. top-level message");
  });

  test("falls back to raw text when JSON has no message fields", async () => {
    mockFetch(new Response("not-json-body", { status: 502 }));

    await expect(
      callAnthropic({
        model: "claude-test",
        compiledPrompt: "prompt",
        apiKey: "key",
      }),
    ).rejects.toThrow("Anthropic error 502. not-json-body");
  });

  test("extracts text from legacy content array format", async () => {
    mockFetch(Response.json({ content: [{ text: "legacy text" }] }));

    const result = await callAnthropic({
      model: "claude-test",
      compiledPrompt: "prompt",
      apiKey: "key",
    });

    expect(result).toBe("legacy text");
  });

  test("returns empty string when content is empty array", async () => {
    mockFetch(Response.json({ content: [] }));

    const result = await callAnthropic({
      model: "claude-test",
      compiledPrompt: "prompt",
      apiKey: "key",
    });

    expect(result).toBe("");
  });

  test("auth error without request id omits suffix", async () => {
    mockFetch(
      new Response(JSON.stringify({ error: { message: "unauthorized" } }), {
        status: 401,
      }),
    );

    await expect(
      callAnthropic({
        model: "claude-test",
        compiledPrompt: "prompt",
        apiKey: "bad-key",
      }),
    ).rejects.toThrow(
      "Anthropic auth failed (401). Check ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN.",
    );
  });

  test("generic error uses x-request-id when anthropic-request-id absent", async () => {
    mockFetch(
      new Response(JSON.stringify({ error: { message: "overloaded" } }), {
        status: 500,
        headers: { "x-request-id": "xreq-789" },
      }),
    );

    await expect(
      callAnthropic({
        model: "claude-test",
        compiledPrompt: "prompt",
        apiKey: "key",
      }),
    ).rejects.toThrow("request id: xreq-789");
  });

  test("includes system prompt in body when provided", async () => {
    mockFetch(Response.json({ content: [{ type: "text", text: "ok" }] }));

    await callAnthropic({
      model: "claude-test",
      compiledPrompt: "prompt",
      systemPrompt: "system instructions",
      apiKey: "key",
    });

    const body = JSON.parse(fetchCalls[0]?.init.body as string);
    expect(body.system).toBe("system instructions");
  });

  test("omits system key from body when systemPrompt absent", async () => {
    mockFetch(Response.json({ content: [{ type: "text", text: "ok" }] }));

    await callAnthropic({
      model: "claude-test",
      compiledPrompt: "prompt",
      apiKey: "key",
    });

    const body = JSON.parse(fetchCalls[0]?.init.body as string);
    expect(body.system).toBeUndefined();
  });

  test("omits temperature from body when temperature undefined", async () => {
    mockFetch(Response.json({ content: [{ type: "text", text: "ok" }] }));

    await callAnthropic({
      model: "claude-test",
      compiledPrompt: "prompt",
      apiKey: "key",
    });

    const body = JSON.parse(fetchCalls[0]?.init.body as string);
    expect(body.temperature).toBeUndefined();
  });

  test("includes temperature in body when provided", async () => {
    mockFetch(Response.json({ content: [{ type: "text", text: "ok" }] }));

    await callAnthropic({
      model: "claude-test",
      compiledPrompt: "prompt",
      temperature: 0.5,
      apiKey: "key",
    });

    const body = JSON.parse(fetchCalls[0]?.init.body as string);
    expect(body.temperature).toBe(0.5);
  });

  test("includes temperature zero in body when provided", async () => {
    mockFetch(Response.json({ content: [{ type: "text", text: "ok" }] }));

    await callAnthropic({
      model: "claude-test",
      compiledPrompt: "prompt",
      temperature: 0,
      apiKey: "key",
    });

    const body = JSON.parse(fetchCalls[0]?.init.body as string);
    expect(body.temperature).toBe(0);
  });

  test("error with empty parsed object falls back to raw text", async () => {
    mockFetch(new Response("", { status: 500 }));

    await expect(
      callAnthropic({
        model: "claude-test",
        compiledPrompt: "prompt",
        apiKey: "key",
      }),
    ).rejects.toThrow("Anthropic error 500");
  });
});
