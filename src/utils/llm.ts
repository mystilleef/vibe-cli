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

const SYSTEM_PROMPT = `Mentor for AI agents. Job: surface the one finding that most changes what the agent does next.

Scan (weight by blast radius — severity × irreversibility):
- Constitution: any rule violated or unverified?
- Misalignment: plan serves the user's actual request, not an adjacent one?
- Irreversibility: destructive operation without rollback or safe-stop?
- Assumption lock-in: unverified premise built upon as fact?
- Learning patterns: plan repeats a known mistake category?

Report only the highest-weight finding. If none, confirm sound and name one latent risk.

Intervene:
- Hard risk (constitution, irreversibility): state directly, ask one focused follow-up.
- Soft risk (misalignment, assumption, pattern): ask one Socratic question that externalizes the unexamined premise.
- Sound: one phrase confirming what's working, one latent risk worth watching.

Output: feedback only — no narration, no preamble, no hedging.
Minimum words. Maximum signal.`;

export const FALLBACK_QUESTIONS = [
  "1. Are you directly addressing the user's goal, or has the plan drifted toward a different problem?",
  "2. If any step is irreversible, what rollback or safe-stop check will protect the work?",
  "3. What unstated assumptions need verification before proceeding?",
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
    DEFAULT_MODELS[provider] ||
    "";
  return { provider, model };
}

async function callGemini(model: string, combined: string): Promise<string> {
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
}

async function callOpenAI(model: string, combined: string): Promise<string> {
  await ensureOpenAI();
  if (!openaiClient) throw new Error("OPENAI_API_KEY not set.");
  const res = await openaiClient.chat.completions.create({
    model: model || "o4-mini",
    messages: [{ role: "system", content: combined }],
  });
  return res.choices[0]?.message.content || "";
}

async function callOpenRouter(
  model: string,
  combined: string,
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
    }),
  });
  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  return data.choices[0]?.message.content || "";
}

async function callDeepSeek(model: string, combined: string): Promise<string> {
  if (!process.env.DEEPSEEK_API_KEY)
    throw new Error("DEEPSEEK_API_KEY not set.");
  return callOpenAICompat({
    baseURL: DEEPSEEK_BASE_URL,
    apiKey: process.env.DEEPSEEK_API_KEY,
    model: model || "deepseek-chat",
    prompt: combined,
  });
}

async function callOpenCode(model: string, combined: string): Promise<string> {
  const apiKey = process.env.OPENCODE_API_KEY;
  if (!apiKey) throw new Error("OPENCODE_API_KEY not set.");
  return callOpenAICompat({
    baseURL: OPENCODE_GO_BASE_URL,
    apiKey,
    model: model || "kimi-k2.6",
    prompt: combined,
  });
}

async function callAnthropicProvider(
  model: string,
  systemPrompt: string,
  userContent: string,
  temperature: number,
): Promise<string> {
  return callAnthropic({
    model: model || "claude-haiku-4-5-20251001",
    systemPrompt,
    compiledPrompt: userContent,
    temperature,
  });
}

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
      return callGemini(model, combined);
    case "openai":
      return callOpenAI(model, combined);
    case "openrouter":
      return callOpenRouter(model, combined);
    case "deepseek":
      return callDeepSeek(model, combined);
    case "opencode":
      return callOpenCode(model, combined);
    case "anthropic":
      return callAnthropicProvider(
        model,
        systemPrompt,
        userContent,
        temperature,
      );
    default:
      throw new Error(
        `Unknown provider: ${provider}. Use gemini | openai | openrouter | anthropic | deepseek | opencode.`,
      );
  }
}

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

const PLAN_REVISION_SYSTEM_PROMPT = `AI agent plan reviser.

Address every safety concern; preserve everything else. Prioritize goal alignment when feedback conflicts.
Output ONLY the revised plan — no preamble, no extra text. One paragraph or short numbered list.`;

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

const GATE_SYSTEM_PROMPT = `Go/no-go decision engine for AI agent plans.

Output ONLY one line of valid JSON — no markdown, no extra text:
{"proceed":<bool>,"confidence":<0.0-1.0>,"reason":"<one sentence, 20 words max>"}

- proceed true: safe, scoped, goal-aligned; non-critical improvements don't block
- proceed false: unresolved critical risks, missing rollbacks for irreversible operations, or goal misalignment
- mixed feedback: block unless safety concerns are minor, resolved, or irrelevant to the goal
- confidence: 0.5 = uncertain, ≥0.8 = clear, 1.0 = certain`;

interface GateDecision {
  proceed: boolean;
  confidence: number;
  reason: string;
}

export function parseGateDecision(raw: string): GateDecision {
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
      error: getErrorMessage(err),
    };
  }
}

export async function getMetacognitiveQuestions(
  input: QuestionInput,
): Promise<QuestionOutput> {
  try {
    return await generateResponse(input);
  } catch {
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
  return response.choices[0]?.message.content || "";
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
