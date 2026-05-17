import { getMetacognitiveQuestions } from '../utils/llm.js';
import { addToHistory, getHistorySummary } from '../utils/state.js';

export interface VibeCheckInput {
  goal: string;
  plan: string;
  modelOverride?: { provider?: string; model?: string };
  userPrompt?: string;
  progress?: string;
  uncertainties?: string[];
  taskContext?: string;
  sessionId?: string;
}

export interface VibeCheckOutput {
  questions: string;
}

export async function vibeCheckTool(input: VibeCheckInput): Promise<VibeCheckOutput> {
  try {
    const historySummary = getHistorySummary(input.sessionId);
    const response = await getMetacognitiveQuestions({
      goal: input.goal,
      plan: input.plan,
      modelOverride: input.modelOverride,
      userPrompt: input.userPrompt,
      progress: input.progress,
      uncertainties: input.uncertainties,
      taskContext: input.taskContext,
      sessionId: input.sessionId,
      historySummary,
    });
    addToHistory(input.sessionId, input, response.questions);
    return { questions: response.questions };
  } catch (error) {
    console.error('vibe_check error:', error);
    return { questions: fallbackQuestions() };
  }
}

function fallbackQuestions(): string {
  return [
    '1. Does this plan directly address what the user requested, or might it be solving a different problem?',
    "2. Is there a simpler approach that would meet the user's needs?",
    '3. What unstated assumptions might be limiting the thinking here?',
    "4. How does this align with the user's original intent?",
  ].join('\n');
}
