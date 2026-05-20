/**
 * Interactive CLI demo showcasing the three core vibe-cli primitives:
 * constitution rule, vibe gate check, and learning recording.
 *
 * Runs a scripted walkthrough against a sample risky migration plan, prints
 * formatted terminal output for each step, and cleans up all demo data on
 * completion (or failure) so no state leaks into the user session.
 *
 * @module demo
 */

import { resolveAutosession } from "../utils/autosession.js";
import { loadHistory } from "../utils/state.js";
import { removeLearningEntriesForDemo } from "../utils/storage.js";
import { getConstitution, resetConstitution } from "./constitution.js";
import { vibeGateTool } from "./vibeGate.js";
import { vibeLearnTool } from "./vibeLearn.js";

// ── Terminal formatting helpers ────────────────────────────────────────────

const sgr = (code: number) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;
const bold = sgr(1);
const dim = sgr(2);
const cyan = sgr(36);
const yellow = sgr(33);
const green = sgr(32);
const magenta = sgr(35);

const HEADER_WIDTH = 62;

/** Write a line to stdout (no trailing newline added by caller). */
const ln = (s = "") => process.stdout.write(`${s}\n`);
/** Write raw text to stdout without a trailing newline. */
const wr = (s: string) => process.stdout.write(s);

/** Render a bordered step header with the step number, title, and echo of the equivalent CLI command. */
function stepHeader(n: number, total: number, title: string, cmd: string) {
  ln();
  ln(bold(cyan(`  ┌── Step ${n}/${total}: ${title}`)));
  ln(dim(`  │  $ ${cmd}`));
  ln(dim(`  └${"─".repeat(HEADER_WIDTH)}`));
  ln();
}

/** Pretty-print a JSON value indented two spaces. */
function indentJSON(data: unknown) {
  return JSON.stringify(data, null, 2).replace(/^/gm, "  ");
}

/** Print each non-empty line of `text` in yellow. */
function printQuestions(text: string) {
  for (const line of text.split("\n")) {
    if (line.trim()) ln(`  ${yellow(line)}`);
  }
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Run `fn` while displaying a terminal spinner with `label`; clears the spinner line on completion. */
async function withSpinner<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let i = 0;
  const id = setInterval(() => {
    wr(`\r  ${dim(label)} ${SPINNER[i++ % SPINNER.length]}`);
  }, 80);
  try {
    return await fn();
  } finally {
    clearInterval(id);
    wr(`\r${" ".repeat(label.length + 6)}\r`);
  }
}

/** Options for the interactive demo walkthrough. */
export interface DemoOptions {
  /** Optional provider/model override forwarded to the vibe gate LLM call. */
  modelOverride?: { provider?: string; model?: string };
}

/**
 * Run the three-step interactive demo in the current terminal.
 *
 * Steps:
 * 1. **Constitution** – set a sample safety rule and display it.
 * 2. **Vibe check** – submit a risky migration plan for metacognitive
 *    review and print the LLM feedback.
 * 3. **Learn** – record the identified mistake pattern and print the
 *    stored learning entry.
 *
 * All demo data (constitution rules, learning entries tagged with a
 * unique `demoId`) is cleaned up in a `finally` block so the user's
 * session state is fully restored on return.
 *
 * @param opts - Optional demo configuration.
 * @param opts.modelOverride - Provider/model pair forwarded to the gate LLM.
 *
 * @throws Re-throws any error from the vibe-gate or vibe-learn LLM calls
 *   after cleanup has completed.
 */
export async function runDemo({ modelOverride }: DemoOptions = {}) {
  const demoId = `demo-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const sessionId = resolveAutosession().id;
  await loadHistory();
  const previousRules = getConstitution();

  ln();
  ln(bold(magenta("  ▸ vibe demo")));
  ln(dim("  Metacognitive AI agent oversight — live walkthrough"));
  ln(dim("  Three steps: constitution → check → learn"));

  try {
    // ── Step 1: Constitution ──────────────────────────────────────────────
    const rule =
      "Never execute irreversible operations without a tested rollback plan.";

    stepHeader(
      1,
      3,
      "Set a constitution rule",
      `vibe constitution set --rule "..."`,
    );

    resetConstitution([rule]);
    ln(dim("  Rule:   ") + rule);
    ln();
    ln(indentJSON({ session: sessionId, rules: getConstitution() }));

    // ── Step 2: Vibe Check ────────────────────────────────────────────────
    const checkInput = {
      goal: "Migrate 50M user records to the new schema before Monday deployment",
      plan: "Run ALTER TABLE to add columns, backfill all rows with UPDATE statements, then DROP the legacy columns to finalize the schema.",
      progress:
        "Schema analysis complete. Migration scripts written. Dry-run tested on 1k rows.",
      uncertainties: [
        "No rollback plan if the migration fails mid-way through the 50M rows",
        "Production data volume untested — dry-run covered only 1k rows",
      ],
      ...(modelOverride !== undefined && { modelOverride }),
    };

    stepHeader(
      2,
      3,
      "Run a vibe check on a risky plan",
      'vibe check --goal "..." --plan "..." --uncertainty "..."',
    );

    ln(dim("  Goal:     ") + checkInput.goal);
    ln(dim("  Plan:     ") + checkInput.plan);
    ln(dim("  Progress: ") + checkInput.progress);
    ln(dim("  Unknowns: ") + checkInput.uncertainties.join(" / "));
    ln();

    const checkResult = await withSpinner(
      "Asking LLM for metacognitive feedback",
      () => vibeGateTool(checkInput),
    );

    ln(bold("  Feedback:"));
    ln();
    printQuestions(checkResult.questions);
    ln();
    ln(
      dim("  Decision: ") +
        (checkResult.proceed ? "✓ proceed" : "✗ blocked") +
        dim("  confidence=") +
        checkResult.confidence.toFixed(2) +
        dim("  reason=") +
        checkResult.reason,
    );
    ln(
      `${dim("  JSON:")} ${JSON.stringify({ proceed: checkResult.proceed, confidence: checkResult.confidence, reason: checkResult.reason })}`,
    );

    // ── Step 3: Learn ─────────────────────────────────────────────────────
    const learnInput = {
      mistake:
        "Agent planned a 50M-row schema migration with DROP operations and no rollback strategy.",
      solution:
        "Write and test a rollback script before executing any irreversible schema change on production data.",
      category: "Premature Implementation",
      type: "mistake" as const,
      demoId,
    };

    stepHeader(
      3,
      3,
      "Record the pattern for future sessions",
      `vibe learn --mistake "..." --category "${learnInput.category}" --solution "..."`,
    );

    const learnResult = await vibeLearnTool(learnInput);
    ln(indentJSON(learnResult));

    ln();
    ln(bold(green("  ✓ Demo complete.")));
    ln(
      dim(
        "  Demo data cleared. Use `vibe check` before risky actions, `vibe learn` after mistakes.",
      ),
    );
    ln(
      dim(
        "  Run `vibe schema` for the full JSON schema for agent integration.",
      ),
    );
    ln();
  } finally {
    removeLearningEntriesForDemo(demoId);
    resetConstitution(previousRules);
  }
}
