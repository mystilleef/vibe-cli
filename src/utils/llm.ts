import type { GoogleGenerativeAI } from "@google/generative-ai";
import type OpenAI from "openai";
import { getConstitution } from "../tools/constitution.js";
import { buildAnthropicHeaders, resolveAnthropicConfig } from "./anthropic.js";
import { type GateDecision, parseGateDecision } from "./gateDecision.js";
import { getLearningContextText } from "./storage.js";

export { type GateDecision, parseGateDecision };

/** Lazily-initialized Gemini client; created on first use when GEMINI_API_KEY is set. */
let genAI: GoogleGenerativeAI | null = null;
/** Lazily-initialized OpenAI client; created on first use when OPENAI_API_KEY is set. */
let openaiClient: OpenAI | null = null;

/** OpenRouter chat completions endpoint. */
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
/** DeepSeek OpenAI-compatible base URL. */
const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
/** OpenCode Go-compatible base URL. */
const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";

/** System prompt injected into every metacognitive question generation call. */
const SYSTEM_PROMPT = `Mentor for AI agents. Job: surface the one finding that most changes what the agent does next.

Scan (weight by blast radius — severity × irreversibility):
- Constitution: any rule violated or unverified?
- Misalignment: plan serves the user's actual request, not an adjacent one?
- Irreversibility: destructive operation without rollback or safe-stop?
- Assumption lock-in: unverified premise built upon as fact?
- Learning patterns: plan repeats a known mistake category?

Report only the highest-weight finding. If none, confirm sound and name one latent risk.

Intervene — output must be self-resolvable by the agent; never request user input or confirmation:
- Hard risk (constitution, irreversibility): state the violation; specify what the revised plan must include to resolve it.
- Soft risk (misalignment, assumption, pattern): state the unverified premise; specify what the agent must verify within the revised plan.
- Sound: one phrase confirming what's working, one latent risk worth watching.

Output: feedback only — no narration, no preamble, no hedging.
Minimum words. Maximum signal.`;

/** Static fallback questions returned when the LLM call fails. */
export const FALLBACK_QUESTIONS = [
  "1. Goal alignment: confirm the plan directly addresses the stated goal — no scope drift.",
  "2. Irreversible steps: each must have a tested rollback or safe-stop defined in the plan.",
  "3. Load-bearing assumptions: enumerate each and verify within the plan before proceeding.",
].join("\n");

/** Input payload for metacognitive question generation and gate decisions. */
interface QuestionInput {
  /** Desired outcome the agent wants to achieve. */
  goal: string;
  /** Proposed approach the agent wants reviewed. */
  plan: string;
  /** Optional explicit provider/model override; falls back to env-based detection. */
  modelOverride?: { provider?: string; model?: string };
  /** Original caller request that prompted the check. */
  userPrompt?: string;
  /** Work already completed or current task status. */
  progress?: string;
  /** Known risks, unknowns, or decisions needing scrutiny. */
  uncertainties?: string[];
  /** Additional repository, session, or task details for the reviewer. */
  taskContext?: string;
  /** Active autosession identifier for history correlation. */
  sessionId?: string;
  /** Condensed prior check history for the active session. */
  historySummary?: string;
}

/** Output payload from question generation. */
interface QuestionOutput {
  /** Metacognitive questions or feedback text from the LLM. */
  questions: string;
}

/** Lazily initialize the Gemini SDK client from GEMINI_API_KEY. */
async function ensureGemini() {
  if (!genAI && process.env.GEMINI_API_KEY) {
    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
}

/** Lazily initialize the OpenAI SDK client from OPENAI_API_KEY. */
async function ensureOpenAI() {
  if (!openaiClient && process.env.OPENAI_API_KEY) {
    const { OpenAI } = await import("openai");
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
}

/** Detect the active LLM provider from environment variables. Priority: DEFAULT_LLM_PROVIDER > ANTHROPIC > GEMINI > OPENAI > OPENROUTER > DEEPSEEK > OPENCODE > gemini (fallback). */
export function detectProvider(): string {
  if (process.env.DEFAULT_LLM_PROVIDER) return process.env.DEFAULT_LLM_PROVIDER;
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)
    return "anthropic";
  if (process.env.GEMINI_API_KEY) return "gemini";
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.OPENROUTER_API_KEY) return "openrouter";
  if (process.env.DEEPSEEK_API_KEY) return "deepseek";
  if (process.env.OPENCODE_API_KEY) return "opencode";
  return "gemini";
}

/** Default model identifier for each supported provider. Empty string means the provider requires an explicit --model. */
export const DEFAULT_MODELS: Record<string, string> = {
  gemini: "gemini-2.5-flash",
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5-20251001",
  openrouter: "",
  deepseek: "deepseek-v4-pro",
  opencode: "kimi-k2.6",
};

/**
 * Resolve the effective provider and model from overrides, env vars, and defaults.
 *
 * Provider resolution order: `modelOverride.provider` → `detectProvider()`.
 * Model resolution order: `modelOverride.model` → `DEFAULT_MODEL` env → `DEFAULT_MODELS[provider]` → "".
 */
function resolveProviderAndModel(modelOverride?: {
  provider?: string;
  model?: string;
}): { provider: string; model: string } {
  const provider = modelOverride?.provider || detectProvider();
  const model =
    modelOverride?.model ||
    process.env.DEFAULT_MODEL ||
    DEFAULT_MODELS[provider] ||
    "";
  return { provider, model };
}

/**
 * Classify a Gemini error for retry eligibility.
 *
 * Uses message-substring heuristics since the Gemini SDK may not expose
 * typed error codes at runtime.
 *
 * Retryable (model-not-found, context-length):
 *   - "not found", "context length", "context window"
 *
 * Non-retryable (auth, rate/quota, network, unknown):
 *   - everything else, including "api key", "api_key", "quota", "rate",
 *     "429", "exceeded"
 */
function isRetryableGeminiError(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? err.message.toLowerCase()
      : String(err).toLowerCase();
  return (
    msg.includes("not found") ||
    msg.includes("context length") ||
    msg.includes("context window")
  );
}

/**
 * Call the Gemini API.
 *
 * Falls back to gemini-2.5-flash only for retryable errors
 * (model-not-found, context-length). Auth, rate/quota, network,
 * and unknown errors rethrow immediately.
 */
async function callGemini(
  model: string,
  combined: string,
  temperature?: number,
): Promise<string> {
  await ensureGemini();
  if (!genAI) throw new Error("GEMINI_API_KEY not set.");
  const m = model || "gemini-2.5-pro";
  const request =
    temperature !== undefined
      ? {
          contents: [{ role: "user", parts: [{ text: combined }] }],
          generationConfig: { temperature },
        }
      : combined;
  try {
    return (
      await genAI.getGenerativeModel({ model: m }).generateContent(request)
    ).response.text();
  } catch (err) {
    if (isRetryableGeminiError(err)) {
      return (
        await genAI
          .getGenerativeModel({ model: "gemini-2.5-flash" })
          .generateContent(request)
      ).response.text();
    }
    throw err;
  }
}

/** Call the OpenAI chat completions API. */
async function callOpenAI(
  model: string,
  combined: string,
  temperature?: number,
): Promise<string> {
  await ensureOpenAI();
  if (!openaiClient) throw new Error("OPENAI_API_KEY not set.");
  const res = await openaiClient.chat.completions.create({
    model: model || DEFAULT_MODELS.openai || "gpt-4o-mini",
    messages: [{ role: "system", content: combined }],
    ...(temperature !== undefined && { temperature }),
  });
  return res.choices[0]?.message.content || "";
}

/** Call the OpenRouter API via direct fetch. Requires an explicit --model. */
async function callOpenRouter(
  model: string,
  combined: string,
  temperature?: number,
): Promise<string> {
  if (!process.env.OPENROUTER_API_KEY)
    throw new Error("OPENROUTER_API_KEY not set.");
  if (!model) throw new Error("--model is required with provider openrouter.");
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "HTTP-Referer": "http://localhost",
      "X-Title": "Vibe Check CLI",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: combined }],
      ...(temperature !== undefined && { temperature }),
    }),
  });
  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  return data.choices[0]?.message.content || "";
}

/** Call DeepSeek via its OpenAI-compatible endpoint. */
async function callDeepSeek(
  model: string,
  combined: string,
  temperature?: number,
): Promise<string> {
  if (!process.env.DEEPSEEK_API_KEY)
    throw new Error("DEEPSEEK_API_KEY not set.");
  return callOpenAICompat({
    baseURL: DEEPSEEK_BASE_URL,
    apiKey: process.env.DEEPSEEK_API_KEY,
    model: model || "deepseek-chat",
    prompt: combined,
    ...(temperature !== undefined && { temperature }),
  });
}

/** Call OpenCode via its OpenAI-compatible endpoint. */
async function callOpenCode(
  model: string,
  combined: string,
  temperature?: number,
): Promise<string> {
  const apiKey = process.env.OPENCODE_API_KEY;
  if (!apiKey) throw new Error("OPENCODE_API_KEY not set.");
  return callOpenAICompat({
    baseURL: OPENCODE_GO_BASE_URL,
    apiKey,
    model: model || "kimi-k2.6",
    prompt: combined,
    ...(temperature !== undefined && { temperature }),
  });
}

/**
 * Dispatch an LLM call to the resolved provider.
 *
 * Combines system and user prompts into a single string for providers that do not
 * separate them natively (all except Anthropic, which passes them independently).
 * Throws on unknown provider names.
 */
async function callProvider(
  provider: string,
  model: string,
  systemPrompt: string,
  userContent: string,
  temperature = 0.2,
): Promise<string> {
  const combined = `${systemPrompt}\n\n${userContent}`;

  switch (provider) {
    case "gemini":
      return callGemini(model, combined, temperature);
    case "openai":
      return callOpenAI(model, combined, temperature);
    case "openrouter":
      return callOpenRouter(model, combined, temperature);
    case "deepseek":
      return callDeepSeek(model, combined, temperature);
    case "opencode":
      return callOpenCode(model, combined, temperature);
    case "anthropic":
      return callAnthropic({
        model: model || "claude-haiku-4-5-20251001",
        systemPrompt,
        compiledPrompt: userContent,
        temperature,
      });
    default:
      throw new Error(
        `Unknown provider: ${provider}. Use gemini | openai | openrouter | anthropic | deepseek | opencode.`,
      );
  }
}

/**
 * Assemble the full context block sent to the metacognitive LLM.
 *
 * Includes goal, plan, optional progress/uncertainties/task context, active constitution
 * rules, prior session history, and learning-pattern history. Learning context is
 * controlled by the USE_LEARNING_HISTORY env var (default: "true").
 */
function buildContextSection(input: QuestionInput): string {
  const useLearning = (process.env.USE_LEARNING_HISTORY ?? "true") === "true";
  const learningContext = useLearning ? getLearningContextText() : "";
  const rules = getConstitution();
  return [
    "CONTEXT:",
    `Goal: ${input.goal}`,
    `Plan: ${input.plan}`,
    input.userPrompt ? `User Prompt: ${input.userPrompt}` : "",
    input.progress ? `Progress: ${input.progress}` : "",
    input.uncertainties?.length
      ? `Uncertainties: ${input.uncertainties.join(", ")}`
      : "",
    input.taskContext ? `Task Context: ${input.taskContext}` : "",
    rules.length
      ? `Constitution:\n${rules.map((r) => `- ${r}`).join("\n")}`
      : "",
    input.historySummary ? `History Context: ${input.historySummary}` : "",
    learningContext ? `Learning Context:\n${learningContext}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Core question-generation call: resolves provider, builds context, and returns the LLM response. */
async function generateResponse(input: QuestionInput): Promise<QuestionOutput> {
  const { provider, model } = resolveProviderAndModel(input.modelOverride);
  const responseText = await callProvider(
    provider,
    model,
    SYSTEM_PROMPT,
    buildContextSection(input),
  );
  return { questions: responseText };
}

/** System prompt for the plan-revision LLM call. */
const PLAN_REVISION_SYSTEM_PROMPT = `AI agent plan reviser.

Address every safety concern; preserve everything else. Prioritize goal alignment when feedback conflicts.
Output ONLY the revised plan — no preamble, no extra text. One paragraph or short numbered list.`;

/**
 * Revise a plan to address safety feedback from a prior gate decision.
 *
 * Returns only the revised plan text. Called by `vibeGateTool` when the gate blocks
 * and a retry with revision is warranted.
 */
export async function revisePlan(input: {
  goal: string;
  plan: string;
  feedback: string;
  modelOverride?: { provider?: string; model?: string };
}): Promise<string> {
  const { provider, model } = resolveProviderAndModel(input.modelOverride);
  const userContent = `Goal: ${input.goal}\nBlocked plan: ${input.plan}\nSafety feedback: ${input.feedback}`;
  return callProvider(
    provider,
    model,
    PLAN_REVISION_SYSTEM_PROMPT,
    userContent,
    0.3,
  );
}

/** System prompt for the gate go/no-go decision LLM call. */
const GATE_SYSTEM_PROMPT = `Go/no-go decision engine for AI agent plans.

Output ONLY one line of valid JSON — no markdown, no extra text:
{"proceed":<bool>,"confidence":<0.0-1.0>,"reason":"<one sentence, 20 words max>"}

- proceed true: safe, scoped, goal-aligned; non-critical improvements don't block
- proceed false: unresolved critical risks, missing rollbacks for irreversible operations, or goal misalignment
- mixed feedback: block unless safety concerns are minor, resolved, or irrelevant to the goal
- confidence: 0.5 = uncertain, ≥0.8 = clear, 1.0 = certain`;

/**
 * Request a go/no-go gate decision from the configured LLM.
 *
 * Uses low temperature (0.1) for deterministic verdicts. The returned `GateDecision`
 * always has valid fields — `parseGateDecision` applies a blocking default on parse failure.
 */
export async function getGateDecision(input: {
  goal: string;
  plan: string;
  feedback: string;
  modelOverride?: { provider?: string; model?: string };
}): Promise<GateDecision> {
  const { provider, model } = resolveProviderAndModel(input.modelOverride);
  const userContent = `Goal: ${input.goal}\nPlan: ${input.plan}\nFeedback: ${input.feedback}`;
  const raw = await callProvider(
    provider,
    model,
    GATE_SYSTEM_PROMPT,
    userContent,
    0.1,
  );
  return parseGateDecision(raw);
}

/** Result of an LLM connectivity probe. */
interface VerifyResult {
  /** Whether the probe succeeded. */
  ok: boolean;
  /** Provider that was tested. */
  provider: string;
  /** Model that was tested (or "(default)"). */
  model: string;
  /** Round-trip latency in milliseconds (present on success). */
  latency_ms?: number;
  /** First 200 chars of the LLM response (present on success). */
  response?: string;
  /** Error message (present on failure). */
  error?: string;
}

/**
 * Probe LLM connectivity with a simple echo prompt.
 *
 * Returns latency and a truncated response preview on success, or the error
 * message on failure. Used by `vibe verify` to validate configuration.
 */
export async function verifyConnection(opts?: {
  provider?: string;
  model?: string;
}): Promise<VerifyResult> {
  const provider = opts?.provider || detectProvider();
  const model =
    opts?.model || process.env.DEFAULT_MODEL || DEFAULT_MODELS[provider] || "";
  const probe =
    "Reply with exactly one sentence confirming you are reachable and working.";
  const start = Date.now();
  try {
    const result = await generateResponse({
      goal: probe,
      plan: probe,
      modelOverride: { provider, ...(model && { model }) },
    });
    return {
      ok: true,
      provider,
      model: model || "(default)",
      latency_ms: Date.now() - start,
      response: result.questions.slice(0, 200),
    };
  } catch (err) {
    return {
      ok: false,
      provider,
      model: model || "(default)",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Generate metacognitive review questions for a plan.
 *
 * Returns LLM-generated feedback on success, or the static `FALLBACK_QUESTIONS`
 * on any error. Never throws — callers always receive a usable result.
 */
export async function getMetacognitiveQuestions(
  input: QuestionInput,
): Promise<QuestionOutput> {
  try {
    return await generateResponse(input);
  } catch {
    return { questions: FALLBACK_QUESTIONS };
  }
}

/** Generic OpenAI-compatible caller for providers sharing the OpenAI chat completions schema. */
async function callOpenAICompat({
  baseURL,
  apiKey,
  model,
  prompt,
  temperature,
}: {
  baseURL: string;
  apiKey: string;
  model: string;
  prompt: string;
  temperature?: number;
}): Promise<string> {
  const { OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey, baseURL });
  const response = await client.chat.completions.create({
    model,
    messages: [{ role: "system", content: prompt }],
    ...(temperature !== undefined && { temperature }),
  });
  return response.choices[0]?.message.content || "";
}

/** Options for the raw Anthropic Messages API call. */
interface AnthropicCallOptions {
  /** Model identifier (e.g. "claude-haiku-4-5-20251001"). */
  model: string;
  /** User-role message content. */
  compiledPrompt: string;
  /** Optional system prompt passed as a top-level `system` field. */
  systemPrompt?: string;
  /** Maximum tokens in the response (default: 1024). */
  maxTokens?: number;
  /** Sampling temperature (default: 0.2). */
  temperature?: number;
}

/** Type guard: value is a non-null object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Safely read a string property from an object, returning undefined if absent or non-string. */
function getStringProperty(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const property = value?.[key];
  return typeof property === "string" ? property : undefined;
}

/** Type guard: value is an Anthropic text content block. */
function isAnthropicTextBlock(
  value: unknown,
): value is { type: "text"; text: string } {
  return (
    isRecord(value) && value.type === "text" && typeof value.text === "string"
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
  const errorObject = isRecord(parsedObject?.error)
    ? parsedObject.error
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

/** Extract the first text block from a successful Anthropic Messages API response. */
function extractAnthropicText(
  parsedObject: Record<string, unknown> | undefined,
): string {
  const content = Array.isArray(parsedObject?.content)
    ? parsedObject.content
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
async function callAnthropic({
  model,
  compiledPrompt,
  systemPrompt,
  maxTokens = 1024,
  temperature = 0.2,
}: AnthropicCallOptions): Promise<string> {
  const { baseUrl, apiKey, authToken, version } = resolveAnthropicConfig();
  const headers = buildAnthropicHeaders({
    version,
    ...(apiKey !== undefined && { apiKey }),
    ...(authToken !== undefined && { authToken }),
  });

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    temperature,
    messages: [{ role: "user", content: compiledPrompt }],
  };
  if (systemPrompt) body.system = systemPrompt;

  const response = await fetch(`${baseUrl}/v1/messages`, {
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
