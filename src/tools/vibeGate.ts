import { vibeCheckTool, VibeCheckInput } from './vibeCheck.js';
import { getGateDecision, revisePlan } from '../utils/llm.js';

export interface VibeGateInput extends VibeCheckInput {}

export interface VibeGateOutput {
  proceed: boolean;
  confidence: number;
  reason: string;
  questions: string;
  plan: string;
  attempts: number;
  exhausted?: boolean;
}

export async function vibeGateTool(input: VibeGateInput): Promise<VibeGateOutput> {
  const checkResult = await vibeCheckTool(input);
  const decision = await getGateDecision({
    goal: input.goal,
    plan: input.plan,
    feedback: checkResult.questions,
    modelOverride: input.modelOverride,
  });
  return {
    proceed: decision.proceed,
    confidence: decision.confidence,
    reason: decision.reason,
    questions: checkResult.questions,
    plan: input.plan,
    attempts: 1,
  };
}

export async function vibeGateLoop(
  input: VibeGateInput,
  maxAttempts: number,
): Promise<VibeGateOutput> {
  let plan = input.plan;
  let last!: VibeGateOutput;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await vibeGateTool({ ...input, plan });
    last = { ...last, plan, attempts: attempt };
    if (last.proceed) return last;
    if (attempt < maxAttempts) {
      plan = await revisePlan({
        goal: input.goal,
        plan,
        feedback: last.questions,
        reason: last.reason,
        modelOverride: input.modelOverride,
      });
    }
  }

  return { ...last, exhausted: true };
}
