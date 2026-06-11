import { getConstitution } from "../tools/constitution.js";
import { type GateDecision, parseGateDecision } from "./gateDecision.js";
import { callProvider, resolveProviderAndModel } from "./provider.js";
import { loadProviderSettings, resolveProviderEntry } from "./settings.js";
import { getLearningContextText } from "./storage.js";

export { callProvider, type GateDecision, parseGateDecision };

/** System prompt injected into every mentor feedback generation call. */
const SYSTEM_PROMPT = `Mentor for AI agents. Job: surface the one finding that most changes what the agent does next.

Scan (weight by blast radius — severity × irreversibility):
- Constitution: any rule violated or unverified?
- Misalignment: plan serves the user's actual request, not an adjacent one?
- Irreversibility: destructive operation without rollback or safe-stop?
- Assumption lock-in: unverified premise built upon as fact?
- Learning patterns: plan repeats a known mistake category?

Report only the highest-weight finding. If none, confirm sound and name one latent risk.

Output: actionable, no user input required:
- Hard risk (constitution, irreversibility): state the violation; specify what the revised plan must include to resolve it.
- Soft risk (misalignment, assumption, pattern): state the unverified premise; specify what the revised plan must verify before proceeding.
- Sound: one phrase confirming what works, one latent risk worth watching.

Feedback only — no narration, no preamble, no hedging.
Minimum words. Maximum signal.`;

/** Static fallback feedback returned when the LLM call fails. */
export const FALLBACK_FEEDBACK = [
  "1. Goal alignment: confirm the plan directly addresses the stated goal — no scope drift.",
  "2. Irreversible steps: each must have a tested rollback or safe-stop defined in the plan.",
  "3. Load-bearing assumptions: enumerate each and verify within the plan before proceeding.",
].join("\n");

interface ReviewInput {
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

interface ReviewOutput {
  feedback: string;
}

/**
 * Assemble the full context block sent to the metacognitive LLM.
 *
 * Includes goal, plan, optional progress/uncertainties/task context, active constitution
 * rules, prior session history, and learning-pattern history. Learning context is
 * controlled by the `useLearningHistory` setting (default: true).
 */
function buildContextSection(input: ReviewInput): string {
  const settings = loadProviderSettings();
  const useLearning = settings.useLearningHistory ?? true;
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

async function generateResponse(input: ReviewInput): Promise<ReviewOutput> {
  const { provider, model, credentials } = resolveProviderAndModel(
    input.modelOverride,
  );
  const responseText = await callProvider(
    provider,
    credentials,
    model,
    SYSTEM_PROMPT,
    buildContextSection(input),
  );
  return { feedback: responseText };
}

/** System prompt for the plan-revision LLM call. */
const PLAN_REVISION_SYSTEM_PROMPT = `AI agent plan reviser.

Address the safety concern in the feedback; preserve everything else. Prioritize goal alignment when feedback conflicts.
The revised plan returns for re-evaluation — resolve the concern completely so the gate approves.
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
  blockReason?: string;
  modelOverride?: { provider?: string; model?: string };
}): Promise<string> {
  const { provider, model, credentials } = resolveProviderAndModel(
    input.modelOverride,
  );
  const userContent = [
    `Goal: ${input.goal}`,
    `Blocked plan: ${input.plan}`,
    `Safety feedback: ${input.feedback}`,
    ...(input.blockReason ? [`Block reason: ${input.blockReason}`] : []),
  ].join("\n");
  return callProvider(
    provider,
    credentials,
    model,
    PLAN_REVISION_SYSTEM_PROMPT,
    userContent,
  );
}

/** System prompt for the gate go/no-go decision LLM call. */
const GATE_SYSTEM_PROMPT = `Go/no-go decision engine for AI agent plans.

Output ONLY one line of valid JSON — no markdown, no extra text:
{"proceed":<bool>,"confidence":<0.0-1.0>,"reason":"<one sentence, 20 words max>"}

- proceed true: plan safe, scoped, goal-aligned; feedback confirms sound or raises only minor/irrelevant concerns
- proceed false: unresolved hard risk — constitution violation, missing rollback, or irreversible op without safe-stop
- proceed false: unverified premise critical to safety; goal misalignment
- confidence: 0.5 = uncertain, ≥0.8 = clear, 1.0 = certain`;

/**
 * Request a go/no-go gate decision from the configured LLM.
 *
 * The returned `GateDecision` always has valid fields — `parseGateDecision` applies
 * a blocking default on parse failure.
 */
export async function getGateDecision(input: {
  goal: string;
  plan: string;
  feedback: string;
  modelOverride?: { provider?: string; model?: string };
}): Promise<GateDecision> {
  const { provider, model, credentials } = resolveProviderAndModel(
    input.modelOverride,
  );
  const userContent = `Goal: ${input.goal}\nPlan: ${input.plan}\nFeedback: ${input.feedback}`;
  const raw = await callProvider(
    provider,
    credentials,
    model,
    GATE_SYSTEM_PROMPT,
    userContent,
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
  const probe =
    "Reply with exactly one sentence confirming you are reachable and working.";
  const start = Date.now();
  let providerName = opts?.provider ?? "";
  let modelName = opts?.model ?? "";
  try {
    const resolved = resolveProviderAndModel(opts);
    providerName = resolved.provider.name;
    modelName = resolved.model;
    const responseText = await callProvider(
      resolved.provider,
      resolved.credentials,
      resolved.model,
      SYSTEM_PROMPT,
      buildContextSection({ goal: probe, plan: probe }),
    );
    return {
      ok: true,
      provider: providerName,
      model: modelName,
      latency_ms: Date.now() - start,
      response: responseText.slice(0, 200),
    };
  } catch (err) {
    if (!providerName || !modelName) {
      try {
        const settings = loadProviderSettings();
        const provider = resolveProviderEntry(settings, opts?.provider);
        providerName = provider.name;
        modelName =
          opts?.model ?? settings.model ?? provider.defaultModel ?? "";
      } catch {
        // Keep the original configuration error in the result.
      }
    }
    return {
      ok: false,
      provider: providerName,
      model: modelName || "(default)",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Generate mentor feedback for a plan.
 *
 * Returns LLM-generated feedback on success, or the static `FALLBACK_FEEDBACK`
 * on any error. Never throws — callers always receive a usable result.
 */
export async function getMentorFeedback(
  input: ReviewInput,
): Promise<ReviewOutput> {
  try {
    return await generateResponse(input);
  } catch {
    return { feedback: FALLBACK_FEEDBACK };
  }
}
