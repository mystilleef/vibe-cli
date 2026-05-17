import { resolveAutosession } from "../utils/autosession.js";
import { FALLBACK_QUESTIONS, getMetacognitiveQuestions } from "../utils/llm.js";
import { addToHistory, getHistorySummary } from "../utils/state.js";

export interface VibeCheckInput {
  goal: string;
  plan: string;
  modelOverride?: { provider?: string; model?: string };
  userPrompt?: string;
  progress?: string;
  uncertainties?: string[];
  taskContext?: string;
}

export interface VibeCheckOutput {
  questions: string;
}

export async function vibeCheckTool(
  input: VibeCheckInput,
): Promise<VibeCheckOutput> {
  try {
    const sessionId = resolveAutosession().id;
    const historySummary = getHistorySummary(sessionId);
    const response = await getMetacognitiveQuestions({
      goal: input.goal,
      plan: input.plan,
      modelOverride: input.modelOverride,
      userPrompt: input.userPrompt,
      progress: input.progress,
      uncertainties: input.uncertainties,
      taskContext: input.taskContext,
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
