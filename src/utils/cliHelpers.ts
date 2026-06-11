/**
 * Pure helper functions extracted from src/cli.ts for testability.
 */
import type { runPrune } from "../tools/prune.js";
import type { vibeGateLoop } from "../tools/vibeGate.js";

/**
 * Resolve model override from CLI options.
 *
 * Returns an empty object when neither provider nor model is set,
 * or an object with `modelOverride` containing the provided fields.
 */
export function resolveModelOverride(opts: {
  provider?: string;
  model?: string;
}): { modelOverride?: { provider?: string; model?: string } } {
  return opts.provider || opts.model
    ? {
        modelOverride: {
          ...(opts.provider !== undefined && { provider: opts.provider }),
          ...(opts.model !== undefined && { model: opts.model }),
        },
      }
    : {};
}

/**
 * Build the vibeGateLoop parameters from check command options.
 *
 * This is the pure parameter-building logic extracted from the check command
 * action handler. The actual async invocation and emit/exit remain in cli.ts.
 */
export function buildCheckParams(
  opts: Record<string, string | string[] | undefined>,
  settingsMaxAttempts?: number,
): {
  params: Parameters<typeof vibeGateLoop>[0];
  maxAttempts: number;
} {
  const cliRaw = parseInt(opts["maxAttempts"] as string, 10);
  const fromCli = !Number.isNaN(cliRaw) && cliRaw !== 0 ? cliRaw : undefined;
  const resolved = fromCli ?? settingsMaxAttempts ?? 10;

  return {
    params: {
      goal: opts["goal"] as string,
      plan: opts["plan"] as string,
      ...(opts["progress"] !== undefined && {
        progress: opts["progress"] as string,
      }),
      ...(opts["uncertainty"] !== undefined && {
        uncertainties: opts["uncertainty"] as string[],
      }),
      ...(opts["context"] !== undefined && {
        taskContext: opts["context"] as string,
      }),
      ...(opts["prompt"] !== undefined && {
        userPrompt: opts["prompt"] as string,
      }),
      ...resolveModelOverride(opts as { provider?: string; model?: string }),
    },
    maxAttempts: Math.max(1, resolved),
  };
}

/**
 * Parse numeric prune command options.
 *
 * Parses age and overlap from string to number, returning undefined for
 * absent values. Throws on NaN to match original CLI validation behavior.
 * Range validation (positive, 0..1) is handled by runPrune.
 */
export function parsePruneNumericOpts(opts: Record<string, unknown>): {
  age?: number | undefined;
  overlap?: number | undefined;
} {
  const age =
    opts["age"] !== undefined ? parseInt(opts["age"] as string, 10) : undefined;
  if (age !== undefined && Number.isNaN(age))
    throw new Error("--age must be a valid integer");

  const overlap =
    opts["overlap"] !== undefined
      ? parseFloat(opts["overlap"] as string)
      : undefined;
  if (overlap !== undefined && Number.isNaN(overlap))
    throw new Error("--overlap must be a valid number between 0 and 1");

  return { age, overlap };
}

/**
 * Build the runPrune parameters from CLI options.
 *
 * This is the pure parameter-building logic extracted from the prune command
 * action handler. Range validation is handled by runPrune itself.
 */
export function buildPruneParams(opts: Record<string, unknown>): {
  params: Parameters<typeof runPrune>[0];
} {
  const { age, overlap } = parsePruneNumericOpts(opts);

  return {
    params: {
      ...((opts["learnings"] as boolean) && { learnings: true }),
      ...((opts["duplicates"] as boolean) && { duplicates: true }),
      ...((opts["demos"] as boolean) && { demos: true }),
      ...((opts["sessions"] as boolean) && { sessions: true }),
      ...(age !== undefined && { age }),
      ...(opts["category"] !== undefined && {
        category: opts["category"] as string,
      }),
      ...(overlap !== undefined && { overlap }),
      ...((opts["dryRun"] as boolean) && { dryRun: true }),
      ...((opts["yes"] as boolean) && { yes: true }),
    },
  };
}
