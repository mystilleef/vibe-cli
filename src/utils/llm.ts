import type { GoogleGenerativeAI } from "@google/generative-ai";
import type OpenAI from "openai";
import { getConstitution } from "../tools/constitution.js";
import { buildAnthropicHeaders, resolveAnthropicConfig } from "./anthropic.js";
import { getLearningContextText } from "./storage.js";

let genAI: GoogleGenerativeAI | null = null;
let openaiClient: OpenAI | null = null;

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";

const SYSTEM_PROMPT = `You are a meta-mentor for AI agents: expert at reading intent, spotting dysfunctional patterns, and delivering feedback that advances the goal.

Tone: calibrate per context — validating when the agent is on track, incisive when patterns or assumptions need surfacing, direct when something could derail the work.

Reason silently. Output only the feedback itself — no thought-process narration.

Evaluate in this order:
1. Diagnose: What is the agent doing, what is the goal, and does the approach fit?
2. Pattern-check: Any loops, unspoken assumptions, or misalignments with stated goals?
3. Intervene: If a problem exists, name it precisely and ask one focused question. If the plan is sound, confirm briefly and surface one risk or reminder worth keeping in mind.

Response constraints:
- Aggressively optimize prose for agent, token, and context efficiency.
- Cut every filler word, hedge, and redundant restatement — keep only signal.
- Prefer one sharp question over three vague ones.
- Never exceed what the agent needs to hear right now.`;

export const FALLBACK_QUESTIONS = [
  "1. Does this plan directly address what the user requested, or might it be solving a different problem?",
  "2. Is there a simpler approach that would meet the user's needs?",
  "3. What unstated assumptions might be limiting the thinking here?",
  "4. How does this align with the user's original intent?",
].join("\n");

interface QuestionInput {
  goal: string;
  plan: string;
  modelOverride?: { provider?: string; model?: string };
  userPrompt?: string;
  progress?: string;
  uncertainties?: string[];
  taskContext?: string;
  sessionId?: string;
  historySummary?: string;
}

interface QuestionOutput {
  questions: string;
}

async function ensureGemini() {
  if (!genAI && process.env.GEMINI_API_KEY) {
    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
}

async function ensureOpenAI() {
  if (!openaiClient && process.env.OPENAI_API_KEY) {
    const { OpenAI } = await import("openai");
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
}

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

export const DEFAULT_MODELS: Record<string, string> = {
  gemini: "gemini-2.5-flash",
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5-20251001",
  openrouter: "",
  deepseek: "deepseek-v4-pro",
  opencode: "kimi-k2.6",
};

function resolveProviderAndModel(modelOverride?: {
  provider?: string;
  model?: string;
}): { provider: string; model: string } {
  const provider = modelOverride?.provider || detectProvider();
  const model =
    modelOverride?.model ||
    process.env.DEFAULT_MODEL ||
    DEFAULT_MODELS[provider];
  return { provider, model };
}

async function callProvider(
  provider: string,
  model: string,
  systemPrompt: string,
  userContent: string,
  temperature = 0.2,
): Promise<string> {
  const combined = `${systemPrompt}\n\n${userContent}`;

  if (provider === "gemini") {
    await ensureGemini();
    if (!genAI) throw new Error("GEMINI_API_KEY not set.");
    const m = model || "gemini-2.5-pro";
    try {
      return (
        await genAI.getGenerativeModel({ model: m }).generateContent(combined)
      ).response.text();
    } catch {
      return (
        await genAI
          .getGenerativeModel({ model: "gemini-2.5-flash" })
          .generateContent(combined)
      ).response.text();
    }
  } else if (provider === "openai") {
    await ensureOpenAI();
    if (!openaiClient) throw new Error("OPENAI_API_KEY not set.");
    const res = await openaiClient.chat.completions.create({
      model: model || "o4-mini",
      messages: [{ role: "system", content: combined }],
    });
    return res.choices[0].message.content || "";
  } else if (provider === "openrouter") {
    if (!process.env.OPENROUTER_API_KEY)
      throw new Error("OPENROUTER_API_KEY not set.");
    if (!model)
      throw new Error("--model is required with provider openrouter.");
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
      }),
    });
    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    return data.choices[0].message.content || "";
  } else if (provider === "deepseek") {
    if (!process.env.DEEPSEEK_API_KEY)
      throw new Error("DEEPSEEK_API_KEY not set.");
    return callOpenAICompat({
      baseURL: DEEPSEEK_BASE_URL,
      apiKey: process.env.DEEPSEEK_API_KEY,
      model: model || "deepseek-chat",
      prompt: combined,
    });
  } else if (provider === "opencode") {
    const opencodeApiKey = process.env.OPENCODE_API_KEY;
    if (!opencodeApiKey) throw new Error("OPENCODE_API_KEY not set.");
    return callOpenAICompat({
      baseURL: OPENCODE_GO_BASE_URL,
      apiKey: opencodeApiKey,
      model: model || "kimi-k2.6",
      prompt: combined,
    });
  } else if (provider === "anthropic") {
    return callAnthropic({
      model: model || "claude-haiku-4-5-20251001",
      systemPrompt,
      compiledPrompt: userContent,
      temperature,
    });
  } else {
    throw new Error(
      `Unknown provider: ${provider}. Use gemini | openai | openrouter | anthropic | deepseek | opencode.`,
    );
  }
}

async function generateResponse(input: QuestionInput): Promise<QuestionOutput> {
  const { provider, model } = resolveProviderAndModel(input.modelOverride);

  const useLearning = (process.env.USE_LEARNING_HISTORY ?? "true") === "true";
  const learningContext = useLearning ? getLearningContextText() : "";
  const rules = getConstitution();
  const constitutionBlock = rules.length
    ? `\nConstitution:\n${rules.map((r) => `- ${r}`).join("\n")}`
    : "";

  const contextSection = [
    "CONTEXT:",
    `History Context: ${input.historySummary || "None"}`,
    learningContext ? `Learning Context:\n${learningContext}` : "",
    `Goal: ${input.goal}`,
    `Plan: ${input.plan}`,
    `Progress: ${input.progress || "None"}`,
    `Uncertainties: ${input.uncertainties?.join(", ") || "None"}`,
    `Task Context: ${input.taskContext || "None"}`,
    `User Prompt: ${input.userPrompt || "None"}`,
    constitutionBlock,
  ]
    .filter(Boolean)
    .join("\n");

  const responseText = await callProvider(
    provider,
    model,
    SYSTEM_PROMPT,
    contextSection,
  );
  return { questions: responseText };
}

const PLAN_REVISION_SYSTEM_PROMPT = `You are an AI agent plan reviser. You receive a goal, a blocked plan, and safety feedback explaining what's wrong.

Produce a revised plan that directly addresses every concern raised in the feedback.
Output ONLY the revised plan — no preamble, no explanation, no extra text.
Keep it concise: one paragraph or a short numbered list.`;

export async function revisePlan(input: {
  goal: string;
  plan: string;
  feedback: string;
  reason: string;
  modelOverride?: { provider?: string; model?: string };
}): Promise<string> {
  const { provider, model } = resolveProviderAndModel(input.modelOverride);
  const userContent = `Goal: ${input.goal}\nBlocked plan: ${input.plan}\nBlock reason: ${input.reason}\nSafety feedback: ${input.feedback}`;
  return callProvider(
    provider,
    model,
    PLAN_REVISION_SYSTEM_PROMPT,
    userContent,
    0.3,
  );
}

const GATE_SYSTEM_PROMPT = `You are a go/no-go decision engine for AI agent plans. Read the metacognitive feedback and decide whether the agent should proceed.

Output ONLY a single line of valid JSON with no markdown, no explanation, no extra text:
{"proceed":<bool>,"confidence":<0.0-1.0>,"reason":"<one sentence, 20 words max>"}

- proceed: false when there are unresolved critical risks, missing rollbacks for irreversible operations, or clear misalignment with the goal
- proceed: true when concerns are minor, already addressed, or the plan is fundamentally sound
- confidence: 0.0 = very uncertain, 1.0 = very certain`;

interface GateDecision {
  proceed: boolean;
  confidence: number;
  reason: string;
}

function parseGateDecision(raw: string): GateDecision {
  const stripped = raw
    .replace(/^```(?:json)?\n?/m, "")
    .replace(/\n?```$/m, "")
    .trim();
  const match = stripped.match(/\{[^}]+\}/);
  try {
    const parsed = JSON.parse(match?.[0] ?? stripped);
    if (
      typeof parsed.proceed === "boolean" &&
      typeof parsed.confidence === "number" &&
      typeof parsed.reason === "string"
    ) {
      return {
        proceed: parsed.proceed,
        confidence: Math.min(1, Math.max(0, parsed.confidence)),
        reason: parsed.reason,
      };
    }
  } catch {}
  return {
    proceed: false,
    confidence: 0.5,
    reason: "Gate decision unavailable — defaulting to block.",
  };
}

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

interface VerifyResult {
  ok: boolean;
  provider: string;
  model: string;
  latency_ms?: number;
  response?: string;
  error?: string;
}

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
      modelOverride: { provider, model: model || undefined },
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
      error: getErrorMessage(err),
    };
  }
}

export async function getMetacognitiveQuestions(
  input: QuestionInput,
): Promise<QuestionOutput> {
  try {
    return await generateResponse(input);
  } catch (error) {
    console.error("LLM error:", error);
    return { questions: FALLBACK_QUESTIONS };
  }
}

async function callOpenAICompat({
  baseURL,
  apiKey,
  model,
  prompt,
}: {
  baseURL: string;
  apiKey: string;
  model: string;
  prompt: string;
}): Promise<string> {
  const { OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey, baseURL });
  const response = await client.chat.completions.create({
    model,
    messages: [{ role: "system", content: prompt }],
  });
  return response.choices[0].message.content || "";
}

interface AnthropicCallOptions {
  model: string;
  compiledPrompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
    isRecord(value) && value.type === "text" && typeof value.text === "string"
  );
}

async function callAnthropic({
  model,
  compiledPrompt,
  systemPrompt,
  maxTokens = 1024,
  temperature = 0.2,
}: AnthropicCallOptions): Promise<string> {
  const { baseUrl, apiKey, authToken, version } = resolveAnthropicConfig();
  const headers = buildAnthropicHeaders({ apiKey, authToken, version });

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
