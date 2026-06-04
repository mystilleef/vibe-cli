/** Structured gate verdict returned by `getGateDecision`. */
export interface GateDecision {
  /** Whether the caller may proceed with the plan. */
  proceed: boolean;
  /** Model-reported confidence in the verdict (0.0–1.0). */
  confidence: number;
  /** One-sentence explanation for the verdict. */
  reason: string;
}

/**
 * Parse a raw LLM response into a structured `GateDecision`.
 *
 * Strips markdown fences, then uses a two-stage extraction:
 * 1. Try `JSON.parse` on the full stripped string.
 * 2. On failure, scan for the last balanced `{...}` JSON object via brace counting
 *    (handles `}` inside string values that foil simple regex extraction).
 * Returns a blocking default (`proceed: false`, confidence 0.5) when both stages fail.
 */
export function parseGateDecision(raw: string): GateDecision {
  const stripped = raw
    .replace(/^```(?:json)?\n?/m, "")
    .replace(/\n?```$/m, "")
    .trim();

  // Stage 1: full JSON.parse
  const parsedFull = tryParseGateDecision(stripped);
  if (parsedFull) return parsedFull;

  // Stage 2: extract last balanced-brace JSON object
  const lastOpen = stripped.lastIndexOf("{");
  if (lastOpen !== -1) {
    const end = findMatchingCloseBrace(stripped, lastOpen);
    if (end !== -1) {
      const parsedBrace = tryParseGateDecision(
        stripped.slice(lastOpen, end + 1),
      );
      if (parsedBrace) return parsedBrace;
    }
  }

  // Stage 3: blocking default
  return {
    proceed: false,
    confidence: 0.5,
    reason: "Gate decision unavailable — defaulting to block.",
  };
}

/** Attempt JSON.parse and validation; returns null on any failure. */
function tryParseGateDecision(raw: string): GateDecision | null {
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
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
  return null;
}

/**
 * Find the closing brace that balances the brace at `openIdx`.
 * Tracks string boundaries and escape sequences so braces inside strings
 * do not affect the balance count. Returns -1 when no matching close is found.
 */
function findMatchingCloseBrace(text: string, openIdx: number): number {
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === "\\") {
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (ch === "{") depth++;
      if (ch === "}") {
        depth--;
        if (depth === 0) return i;
      }
    }
  }
  return -1;
}
