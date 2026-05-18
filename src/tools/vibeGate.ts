import { getGateDecision, revisePlan } from "../utils/llm.js";
import { type VibeCheckInput, vibeCheckTool } from "./vibeCheck.js";

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

export async function vibeGateTool(
  input: VibeGateInput,
): Promise<VibeGateOutput> {
  const checkResult = await vibeCheckTool(input);
  const decision = await getGateDecision({
    goal: input.goal,
    plan: input.plan,
    feedback: checkResult.questions,
    ...(input.modelOverride !== undefined && {
      modelOverride: input.modelOverride,
    }),
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
    const toolResult = await vibeGateTool({ ...input, plan });
    last = { ...toolResult, plan, attempts: attempt };
    if (last.proceed) return last;
    if (attempt < maxAttempts) {
      plan = await revisePlan({
        goal: input.goal,
        plan,
        feedback: last.questions,
        reason: last.reason,
        ...(input.modelOverride !== undefined && {
          modelOverride: input.modelOverride,
        }),
      });
    }
  }

  return { ...last, exhausted: true };
}
