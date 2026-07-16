import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  buildAnthropicHeaders,
  callAnthropic,
  resolveAnthropicConfig,
} from "../src/utils/anthropic";
import type { ThinkingLevel } from "../src/utils/settings";

const ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

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

  test("trims trailing slashes from baseUrl override", () => {
    process.env["ANTHROPIC_API_KEY"] = "k";
    const cfg = resolveAnthropicConfig({
      baseUrl: "https://proxy.example.com///",
    });
    expect(cfg.baseUrl).toBe("https://proxy.example.com");
  });

  test("prefers ANTHROPIC_API_KEY over ANTHROPIC_AUTH_TOKEN when both set", () => {
    process.env["ANTHROPIC_API_KEY"] = "key-first";
    process.env["ANTHROPIC_AUTH_TOKEN"] = "tok-second";
    const cfg = resolveAnthropicConfig();
    expect(cfg.apiKey).toBe("key-first");
    expect(cfg.authToken).toBe("tok-second");
  });

  test("uses override apiKey when passed directly", () => {
    const cfg = resolveAnthropicConfig({ apiKey: "override-key" });
    expect(cfg.apiKey).toBe("override-key");
    expect(cfg.authToken).toBeUndefined();
    expect(cfg.baseUrl).toBe("https://api.anthropic.com");
    expect(cfg.version).toBe("2023-06-01");
  });

  test("uses override authToken when passed directly", () => {
    const cfg = resolveAnthropicConfig({ authToken: "override-token" });
    expect(cfg.authToken).toBe("override-token");
    expect(cfg.apiKey).toBeUndefined();
  });

  test("uses override version when passed directly", () => {
    process.env["ANTHROPIC_API_KEY"] = "k";
    const cfg = resolveAnthropicConfig({ version: "2024-02-15" });
    expect(cfg.version).toBe("2024-02-15");
  });

  test("baseUrl without trailing slashes is not mutated", () => {
    process.env["ANTHROPIC_API_KEY"] = "k";
    const cfg = resolveAnthropicConfig({
      baseUrl: "https://clean.example.com",
    });
    expect(cfg.baseUrl).toBe("https://clean.example.com");
  });
});

describe("callAnthropic", () => {
  test("uses injected metadata and credentials instead of defaults", async () => {
    process.env["ANTHROPIC_API_KEY"] = "env-key";
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

  test("uses custom maxTokens in request body", async () => {
    mockFetch(Response.json({ content: [{ type: "text", text: "ok" }] }));

    await callAnthropic({
      model: "claude-test",
      compiledPrompt: "prompt",
      maxTokens: 512,
      apiKey: "key",
    });

    const body = JSON.parse(fetchCalls[0]?.init.body as string);
    expect(body.max_tokens).toBe(512);
  });

  test("uses default maxTokens 1024 when not provided", async () => {
    mockFetch(Response.json({ content: [{ type: "text", text: "ok" }] }));

    await callAnthropic({
      model: "claude-test",
      compiledPrompt: "prompt",
      apiKey: "key",
    });

    const body = JSON.parse(fetchCalls[0]?.init.body as string);
    expect(body.max_tokens).toBe(1024);
  });

  test("both injected apiKey and authToken prefers apiKey in headers", async () => {
    mockFetch(Response.json({ content: [{ type: "text", text: "ok" }] }));

    await callAnthropic({
      model: "claude-test",
      compiledPrompt: "prompt",
      apiKey: "injected-key",
      authToken: "injected-token",
    });

    expect(fetchCalls[0]?.init.headers).toMatchObject({
      "x-api-key": "injected-key",
    });
    expect(fetchCalls[0]?.init.headers).not.toMatchObject({
      authorization: expect.any(String),
    });
  });

  test("extracts text when first content block is non-text type and second is text", async () => {
    mockFetch(
      Response.json({
        content: [
          { type: "image", source: "base64" },
          { type: "text", text: "second block" },
        ],
      }),
    );

    const result = await callAnthropic({
      model: "claude-test",
      compiledPrompt: "prompt",
      apiKey: "key",
    });

    expect(result).toBe("second block");
  });

  test("extracts text from bare content block without type field", async () => {
    mockFetch(Response.json({ content: [{ text: "bare text block" }] }));

    const result = await callAnthropic({
      model: "claude-test",
      compiledPrompt: "prompt",
      apiKey: "key",
    });

    expect(result).toBe("bare text block");
  });

  // ── Thinking: inactive (undefined / off) ─────────────────────────────

  test("thinking undefined omits thinking body and beta header", async () => {
    mockFetch(Response.json({ content: [{ type: "text", text: "ok" }] }));

    await callAnthropic({
      model: "claude-test",
      compiledPrompt: "prompt",
      apiKey: "key",
    });

    const body = JSON.parse(fetchCalls[0]?.init.body as string);
    expect(body.thinking).toBeUndefined();
    expect(fetchCalls[0]?.init.headers).not.toHaveProperty("anthropic-beta");
  });

  test("thinking undefined preserves caller temperature", async () => {
    mockFetch(Response.json({ content: [{ type: "text", text: "ok" }] }));

    await callAnthropic({
      model: "claude-test",
      compiledPrompt: "prompt",
      temperature: 0.3,
      apiKey: "key",
    });

    const body = JSON.parse(fetchCalls[0]?.init.body as string);
    expect(body.temperature).toBe(0.3);
  });

  test("thinking undefined preserves caller max_tokens", async () => {
    mockFetch(Response.json({ content: [{ type: "text", text: "ok" }] }));

    await callAnthropic({
      model: "claude-test",
      compiledPrompt: "prompt",
      maxTokens: 512,
      apiKey: "key",
    });

    const body = JSON.parse(fetchCalls[0]?.init.body as string);
    expect(body.max_tokens).toBe(512);
  });

  test("thinking undefined omits temperature from body when absent", async () => {
    mockFetch(Response.json({ content: [{ type: "text", text: "ok" }] }));

    await callAnthropic({
      model: "claude-test",
      compiledPrompt: "prompt",
      apiKey: "key",
    });

    const body = JSON.parse(fetchCalls[0]?.init.body as string);
    expect(body.temperature).toBeUndefined();
  });

  test("thinking off behaves identically to undefined", async () => {
    mockFetch(Response.json({ content: [{ type: "text", text: "ok" }] }));

    await callAnthropic({
      model: "claude-test",
      compiledPrompt: "prompt",
      temperature: 0.5,
      maxTokens: 512,
      thinking: "off",
      apiKey: "key",
    });

    const body = JSON.parse(fetchCalls[0]?.init.body as string);
    expect(body.thinking).toBeUndefined();
    expect(body.temperature).toBe(0.5);
    expect(body.max_tokens).toBe(512);
    expect(fetchCalls[0]?.init.headers).not.toHaveProperty("anthropic-beta");
  });

  // ── Thinking: active levels ───────────────────────────────────────────

  test.each([
    ["low" as ThinkingLevel, 2048],
    ["medium" as ThinkingLevel, 4096],
    ["high" as ThinkingLevel, 8192],
    ["xhigh" as ThinkingLevel, 16384],
  ])(
    "active level %p sends thinking block with budget %d",
    async (level, expectedBudget) => {
      mockFetch(Response.json({ content: [{ type: "text", text: "ok" }] }));

      await callAnthropic({
        model: "claude-test",
        compiledPrompt: "prompt",
        thinking: level,
        apiKey: "key",
      });

      const body = JSON.parse(fetchCalls[0]?.init.body as string);
      expect(body.thinking).toEqual({
        type: "enabled",
        budget_tokens: expectedBudget,
      });
    },
  );

  test.each(["low", "medium", "high", "xhigh"] as ThinkingLevel[])(
    "active level %p adds thinking-1.0 beta header",
    async (level) => {
      mockFetch(Response.json({ content: [{ type: "text", text: "ok" }] }));

      await callAnthropic({
        model: "claude-test",
        compiledPrompt: "prompt",
        thinking: level,
        apiKey: "key",
      });

      expect(fetchCalls[0]?.init.headers).toMatchObject({
        "anthropic-beta": "thinking-1.0",
      });
    },
  );

  test.each(["low", "medium", "high", "xhigh"] as ThinkingLevel[])(
    "active level %p forces temperature to 1.0 regardless of caller value",
    async (level) => {
      mockFetch(Response.json({ content: [{ type: "text", text: "ok" }] }));

      await callAnthropic({
        model: "claude-test",
        compiledPrompt: "prompt",
        thinking: level,
        temperature: 0.2,
        apiKey: "key",
      });

      const body = JSON.parse(fetchCalls[0]?.init.body as string);
      expect(body.temperature).toBe(1.0);
    },
  );

  test("active thinking forces temperature to 1.0 even when caller omits temperature", async () => {
    mockFetch(Response.json({ content: [{ type: "text", text: "ok" }] }));

    await callAnthropic({
      model: "claude-test",
      compiledPrompt: "prompt",
      thinking: "medium",
      apiKey: "key",
    });

    const body = JSON.parse(fetchCalls[0]?.init.body as string);
    expect(body.temperature).toBe(1.0);
  });

  // ── Thinking: max_tokens floor ────────────────────────────────────────

  test("active thinking enforces max_tokens floor at budget + 1024 when default maxTokens is low", async () => {
    mockFetch(Response.json({ content: [{ type: "text", text: "ok" }] }));

    await callAnthropic({
      model: "claude-test",
      compiledPrompt: "prompt",
      thinking: "medium",
      apiKey: "key",
    });

    const body = JSON.parse(fetchCalls[0]?.init.body as string);
    // budget 4096 + 1024 = 5120; default maxTokens is 1024, so floor wins
    expect(body.max_tokens).toBe(5120);
  });

  test("active thinking enforces max_tokens floor when explicit maxTokens < budget + 1024", async () => {
    mockFetch(Response.json({ content: [{ type: "text", text: "ok" }] }));

    await callAnthropic({
      model: "claude-test",
      compiledPrompt: "prompt",
      thinking: "xhigh",
      maxTokens: 4096,
      apiKey: "key",
    });

    const body = JSON.parse(fetchCalls[0]?.init.body as string);
    // budget 16384 + 1024 = 17408; explicit 4096 is lower, floor wins
    expect(body.max_tokens).toBe(17408);
  });

  test("active thinking preserves explicit maxTokens when it exceeds floor", async () => {
    mockFetch(Response.json({ content: [{ type: "text", text: "ok" }] }));

    await callAnthropic({
      model: "claude-test",
      compiledPrompt: "prompt",
      thinking: "low",
      maxTokens: 10000,
      apiKey: "key",
    });

    const body = JSON.parse(fetchCalls[0]?.init.body as string);
    // budget 2048 + 1024 = 3072; explicit 10000 is higher, preserved
    expect(body.max_tokens).toBe(10000);
  });

  test("low thinking with default maxTokens enforces floor at 3072", async () => {
    mockFetch(Response.json({ content: [{ type: "text", text: "ok" }] }));

    await callAnthropic({
      model: "claude-test",
      compiledPrompt: "prompt",
      thinking: "low",
      apiKey: "key",
    });

    const body = JSON.parse(fetchCalls[0]?.init.body as string);
    // budget 2048 + 1024 = 3072; default 1024 is lower
    expect(body.max_tokens).toBe(3072);
  });

  // ── Thinking: non-text response blocks filtered ───────────────────────

  test("extracts text when thinking blocks precede text blocks", async () => {
    mockFetch(
      Response.json({
        content: [
          { type: "thinking", thinking: "internal reasoning" },
          { type: "text", text: "visible text" },
        ],
      }),
    );

    const result = await callAnthropic({
      model: "claude-test",
      compiledPrompt: "prompt",
      thinking: "high",
      apiKey: "key",
    });

    expect(result).toBe("visible text");
  });

  test("returns empty string when all content blocks are thinking type", async () => {
    mockFetch(
      Response.json({
        content: [
          { type: "thinking", thinking: "first" },
          { type: "thinking", thinking: "second" },
        ],
      }),
    );

    const result = await callAnthropic({
      model: "claude-test",
      compiledPrompt: "prompt",
      thinking: "high",
      apiKey: "key",
    });

    expect(result).toBe("");
  });

  test("ignores thinking-only response without active thinking setting", async () => {
    mockFetch(
      Response.json({
        content: [
          { type: "thinking", thinking: "reasoning" },
          { type: "text", text: "final" },
        ],
      }),
    );

    // thinking inactive but response contains thinking blocks — still filters
    const result = await callAnthropic({
      model: "claude-test",
      compiledPrompt: "prompt",
      apiKey: "key",
    });

    expect(result).toBe("final");
  });

  // ── Thinking: error handling preserved ─────────────────────────────────

  test("auth error message preserved when thinking is active", async () => {
    mockFetch(
      new Response(JSON.stringify({ error: { message: "invalid key" } }), {
        status: 401,
        headers: { "anthropic-request-id": "req-auth-001" },
      }),
    );

    await expect(
      callAnthropic({
        model: "claude-test",
        compiledPrompt: "prompt",
        thinking: "high",
        apiKey: "bad-key",
      }),
    ).rejects.toThrow(
      "Anthropic auth failed (401) (request id: req-auth-001). Check ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN.",
    );
  });

  test("rate limit error message preserved when thinking is active", async () => {
    mockFetch(
      new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "retry-after": "30", "anthropic-request-id": "req-rate" },
      }),
    );

    await expect(
      callAnthropic({
        model: "claude-test",
        compiledPrompt: "prompt",
        thinking: "medium",
        apiKey: "key",
      }),
    ).rejects.toThrow(
      "Anthropic rate limited (429) (request id: req-rate). Retry after 30s.",
    );
  });

  test("generic provider error preserved when thinking is active", async () => {
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
        thinking: "xhigh",
        apiKey: "key",
      }),
    ).rejects.toThrow(
      "Anthropic error 503 (request id: req-xyz). server overloaded",
    );
  });

  // ── Thinking: combined payload shape ──────────────────────────────────

  test("active thinking request carries thinking block, beta header, forced temperature, and system prompt", async () => {
    mockFetch(Response.json({ content: [{ type: "text", text: "ok" }] }));

    await callAnthropic({
      model: "claude-opus",
      compiledPrompt: "solve this",
      systemPrompt: "be precise",
      thinking: "high",
      temperature: 0.0,
      maxTokens: 4096,
      apiKey: "key",
      version: "2024-02-15",
    });

    const body = JSON.parse(fetchCalls[0]?.init.body as string);
    const headers = fetchCalls[0]?.init.headers as Record<string, string>;

    expect(body.thinking).toEqual({
      type: "enabled",
      budget_tokens: 8192,
    });
    expect(body.temperature).toBe(1.0);
    expect(body.max_tokens).toBe(9216);
    expect(body.system).toBe("be precise");
    expect(body.model).toBe("claude-opus");
    expect(headers["anthropic-beta"]).toBe("thinking-1.0");
    expect(headers["anthropic-version"]).toBe("2024-02-15");
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

  test("prefers anthropic-request-id over x-request-id in error", async () => {
    mockFetch(
      new Response(JSON.stringify({ error: { message: "server error" } }), {
        status: 500,
        headers: {
          "anthropic-request-id": "anth-req-123",
          "x-request-id": "xreq-456",
        },
      }),
    );

    await expect(
      callAnthropic({
        model: "claude-test",
        compiledPrompt: "prompt",
        apiKey: "key",
      }),
    ).rejects.toThrow("request id: anth-req-123");
    await expect(
      callAnthropic({
        model: "claude-test",
        compiledPrompt: "prompt",
        apiKey: "key",
      }),
    ).rejects.not.toThrow("xreq-456");
  });

  test("429 rate limit with retry-after and request id", async () => {
    mockFetch(
      new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: {
          "retry-after": "15",
          "anthropic-request-id": "req-rate",
        },
      }),
    );

    await expect(
      callAnthropic({
        model: "claude-test",
        compiledPrompt: "prompt",
        apiKey: "key",
      }),
    ).rejects.toThrow(
      "Anthropic rate limited (429) (request id: req-rate). Retry after 15s.",
    );
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

  test("emits anthropic-beta header when betas provided", () => {
    const h = buildAnthropicHeaders({
      apiKey: "key",
      version: "2023-06-01",
      betas: ["thinking-1.0", "feature-x"],
    });
    expect(h["anthropic-beta"]).toBe("thinking-1.0,feature-x");
  });

  test("emits anthropic-beta with single beta value", () => {
    const h = buildAnthropicHeaders({
      apiKey: "key",
      version: "2023-06-01",
      betas: ["thinking-1.0"],
    });
    expect(h["anthropic-beta"]).toBe("thinking-1.0");
  });

  test("omits anthropic-beta when betas is undefined", () => {
    const h = buildAnthropicHeaders({
      apiKey: "key",
      version: "2023-06-01",
    });
    expect(h["anthropic-beta"]).toBeUndefined();
  });

  test("omits anthropic-beta when betas is empty array", () => {
    const h = buildAnthropicHeaders({
      apiKey: "key",
      version: "2023-06-01",
      betas: [],
    });
    expect(h["anthropic-beta"]).toBeUndefined();
  });
});
