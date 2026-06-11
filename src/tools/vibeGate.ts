import { getGateDecision, revisePlan } from "../utils/llm.js";
import { type VibeCheckInput, vibeCheckTool } from "./vibeCheck.js";

export type { VibeCheckInput };

export interface VibeGateOutput {
  /** Whether the caller may proceed with the reviewed plan. */
  proceed: boolean;
  /** Model-reported confidence in the gate verdict. */
  confidence: number;
  /** Explanation for the gate verdict, especially when blocking progress. */
  reason: string;
  /** Mentor feedback used for the gate decision. */
  feedback: string;
  /** Plan text reviewed on the final attempt. */
  plan: string;
  /** Number of gate attempts consumed by the returned verdict. */
  attempts: number;
  /** Present when the loop stops because the attempt budget ran out. */
  exhausted?: boolean;
}

/**
 * Runs one blocking gate review for a plan.
 *
 * Generates mentor feedback first, passes it into the gate decision as
 * safety feedback, and returns the verdict for the original plan. Feedback
 * generation failures use the fallback feedback from `vibeCheckTool`; gate
 * decision failures still reject to callers.
 */
export async function vibeGateTool(
  input: VibeCheckInput,
): Promise<VibeGateOutput> {
  const checkResult = await vibeCheckTool(input);
  const decision = await getGateDecision({
    goal: input.goal,
    plan: input.plan,
    feedback: checkResult.feedback,
    ...(input.modelOverride !== undefined && {
      modelOverride: input.modelOverride,
    }),
  });
  return {
    proceed: decision.proceed,
    confidence: decision.confidence,
    reason: decision.reason,
    feedback: checkResult.feedback,
    plan: input.plan,
    attempts: 1,
  };
}

/**
 * Rechecks and revises a plan until the gate approves or attempts run out.
 *
 * Each blocked attempt can produce one revised plan for the next attempt. The
 * returned `plan` is the final reviewed plan, not a pending revision. When
 * `maxAttempts` is zero, no provider calls run and the boundary result only
 * reports exhaustion.
 */
export async function vibeGateLoop(
  input: VibeCheckInput,
  maxAttempts: number,
): Promise<VibeGateOutput> {
  if (maxAttempts <= 0) {
    return {
      proceed: false,
      confidence: 0,
      reason: "No attempts remaining",
      feedback: "",
      plan: input.plan,
      attempts: 0,
      exhausted: true,
    };
  }

  let plan = input.plan;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const toolResult = await vibeGateTool({ ...input, plan });
    if (toolResult.proceed) {
      return { ...toolResult, plan, attempts: attempt };
    }
    if (attempt === maxAttempts) {
      return { ...toolResult, plan, attempts: attempt, exhausted: true };
    }
    plan = await revisePlan({
      goal: input.goal,
      plan,
      feedback: toolResult.feedback,
      blockReason: toolResult.reason,
      ...(input.modelOverride !== undefined && {
        modelOverride: input.modelOverride,
      }),
    });
  }

  // Unreachable: loop always returns.
  throw new Error("vibeGateLoop: unexpected loop exit");
}
