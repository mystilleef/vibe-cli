import { resolveAutosession } from "../utils/autosession.js";
import { FALLBACK_QUESTIONS, getMetacognitiveQuestions } from "../utils/llm.js";
import { addToHistory, getHistorySummary } from "../utils/state.js";

/** Describes the plan context sent to the metacognitive question generator. */
export interface VibeCheckInput {
  /** Desired outcome the agent wants to achieve. */
  goal: string;
  /** Proposed approach the agent wants reviewed before acting. */
  plan: string;
  /** Optional provider or model selection passed through to the LLM layer. */
  modelOverride?: { provider?: string; model?: string };
  /** Original caller request that prompted the check. */
  userPrompt?: string;
  /** Work already completed or current task status. */
  progress?: string;
  /** Known risks, unknowns, or decisions needing scrutiny. */
  uncertainties?: string[];
  /** Additional repository, session, or task details for the reviewer. */
  taskContext?: string;
}

/** Contains the review questions returned to the caller. */
export interface VibeCheckOutput {
  /** Metacognitive questions from the configured LLM, or fallback questions on failure. */
  questions: string;
}

/**
 * Runs a metacognitive check for a plan and records the exchange in autosession history.
 *
 * Reuses prior history from the resolved autosession, forwards all supplied optional
 * context to the question generator, then stores the returned questions for future
 * checks. On any failure, logs the error and returns the fallback question set without
 * throwing to callers.
 */
export async function vibeCheckTool(
  input: VibeCheckInput,
): Promise<VibeCheckOutput> {
  try {
    const sessionId = resolveAutosession().id;
    const historySummary = getHistorySummary(sessionId);
    const response = await getMetacognitiveQuestions({
      goal: input.goal,
      plan: input.plan,
      ...(input.modelOverride !== undefined && {
        modelOverride: input.modelOverride,
      }),
      ...(input.userPrompt !== undefined && { userPrompt: input.userPrompt }),
      ...(input.progress !== undefined && { progress: input.progress }),
      ...(input.uncertainties !== undefined && {
        uncertainties: input.uncertainties,
      }),
      ...(input.taskContext !== undefined && {
        taskContext: input.taskContext,
      }),
      sessionId,
      historySummary,
    });
    await addToHistory(sessionId, input, response.questions);
    return { questions: response.questions };
  } catch (error) {
    console.error("vibe_check error:", error);
    return { questions: FALLBACK_QUESTIONS };
  }
}
