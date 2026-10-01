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
import {
  removeLearningEntriesForDemo,
  removeStaleDemoEntries,
} from "../utils/storage.js";
import { getConstitution, resetConstitution } from "./constitution.js";
import {
  type VibeCheckInput,
  type VibeGateOutput,
  vibeGateTool,
} from "./vibeGate.js";
import { vibeLearnTool } from "./vibeLearn.js";

// ── Terminal formatting helpers ────────────────────────────────────────────

const ansi = (code: number) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;
const bold = ansi(1);
const dim = ansi(2);
const cyan = ansi(36);
const yellow = ansi(33);
const green = ansi(32);
const magenta = ansi(35);

const HEADER_WIDTH = 62;

/** Write a line to stdout, appending a trailing newline. */
const line = (s = "") => process.stdout.write(`${s}\n`);
/** Write raw text to stdout without a trailing newline. */
const write = (s: string) => process.stdout.write(s);

/** Render a bordered step header with the step number, title, and echo of the equivalent CLI command. */
function stepHeader(n: number, total: number, title: string, cmd: string) {
  line();
  line(bold(cyan(`  ┌── Step ${n}/${total}: ${title}`)));
  line(dim(`  │  $ ${cmd}`));
  line(dim(`  └${"─".repeat(HEADER_WIDTH)}`));
  line();
}

/** Pretty-print a JSON value indented two spaces. */
function indentJSON(data: unknown) {
  return JSON.stringify(data, null, 2).replace(/^/gm, "  ");
}

/** Print each non-empty line of `text` in yellow. */
function printFeedback(text: string) {
  for (const textLine of text.split("\n")) {
    if (textLine.trim()) line(`  ${yellow(textLine)}`);
  }
}

function printGateResult(result: VibeGateOutput) {
  line(bold("  Feedback:"));
  line();
  printFeedback(result.feedback);
  line();
  line(
    dim("  Decision: ") +
      (result.proceed ? "✓ proceed" : "✗ blocked") +
      dim("  confidence=") +
      result.confidence.toFixed(2) +
      dim("  reason=") +
      result.reason,
  );
  line(
    `${dim("  JSON:")} ${JSON.stringify({ proceed: result.proceed, confidence: result.confidence, reason: result.reason })}`,
  );
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Run `fn` while displaying a terminal spinner with `label`; clears the spinner line on completion. */
async function withSpinner<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let i = 0;
  const id = setInterval(() => {
    write(`\r  ${dim(label)} ${SPINNER[i++ % SPINNER.length]}`);
  }, 80);
  try {
    return await fn();
  } finally {
    clearInterval(id);
    write(`\r${" ".repeat(label.length + 6)}\r`);
  }
}

/** Options for the interactive demo walkthrough. */
interface DemoOptions {
  /** Optional provider/model override forwarded to the vibe gate LLM call. */
  modelOverride?: { provider?: string; model?: string };
}

/** Plan context printed and submitted for one demo vibe check. */
type DemoCheckInput = Required<
  Pick<VibeCheckInput, "goal" | "plan" | "progress" | "uncertainties">
>;

/** Print the walkthrough banner shown before the first step. */
function printDemoIntro() {
  line();
  line(bold(magenta("  ▸ vibe demo")));
  line(dim("  Metacognitive AI agent oversight — live walkthrough"));
  line(
    dim(
      "  Four steps: constitution → check (blocked) → check (approved) → learn",
    ),
  );
}

/** Step 1 — install the sample constitution rule and display the session state. */
function runConstitutionStep(sessionId: string) {
  const rule =
    "Never execute irreversible operations without a tested rollback plan.";

  stepHeader(
    1,
    4,
    "Set a constitution rule",
    `vibe constitution set --rule "..."`,
  );

  resetConstitution([rule]);
  line(dim("  Rule:   ") + rule);
  line();
  line(indentJSON({ session: sessionId, rules: getConstitution() }));
}

/** Print the plan context and run one vibe check through the gate LLM. */
async function runCheckStep(
  step: number,
  title: string,
  cmd: string,
  input: DemoCheckInput,
  modelOverride: DemoOptions["modelOverride"],
): Promise<VibeGateOutput> {
  stepHeader(step, 4, title, cmd);
  line(dim("  Goal:     ") + input.goal);
  line(dim("  Plan:     ") + input.plan);
  line(dim("  Progress: ") + input.progress);
  line(
    dim("  Unknowns: ") +
      (input.uncertainties.length ? input.uncertainties.join(" / ") : "(none)"),
  );
  line();
  return withSpinner("Asking LLM for metacognitive feedback", () =>
    vibeGateTool({
      ...input,
      ...(modelOverride !== undefined && { modelOverride }),
    }),
  );
}

/** Step 4 — record the demo success pattern as a learning entry. */
async function runLearnStep(demoId: string) {
  const learnInput = {
    observation:
      "Safe migration pattern: rollback script, dry-run, staged rollout with monitoring.",
    solution:
      "Always write and test a rollback script, dry-run on a small batch, then execute in staged batches with monitoring.",
    category: "Safe Migration",
    type: "success" as const,
    demoId,
  };

  stepHeader(
    4,
    4,
    "Record the pattern for future sessions",
    `vibe learn --mistake "..." --category "${learnInput.category}" --solution "..." --type success`,
  );

  const learnResult = await vibeLearnTool(learnInput);
  line(indentJSON(learnResult));
}

/** Print the closing guidance shown after the final step. */
function printDemoOutro() {
  line();
  line(bold(green("  ✓ Demo complete.")));
  line(
    dim(
      "  Demo data cleared. Use `vibe check` before risky actions, `vibe learn` after mistakes.",
    ),
  );
  line(
    dim("  Run `vibe schema` for the full JSON schema for agent integration."),
  );
  line();
}

/**
 * Run the four-step interactive demo in the current terminal.
 *
 * Steps:
 * 1. **Constitution** – set a sample safety rule and display it.
 * 2. **Vibe check** – submit a risky migration plan for metacognitive
 *    review and print the LLM feedback.
 * 3. **Vibe check** – submit a safe migration plan for approval.
 * 4. **Learn** – record the identified success pattern and print the
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
  const previousRules = getConstitution();

  printDemoIntro();

  try {
    // Clean up stale demo entries from crashed runs to prevent isSimilar() suppression.
    removeStaleDemoEntries();

    runConstitutionStep(sessionId);

    const checkResult = await runCheckStep(
      2,
      "Run a vibe check on a risky plan",
      'vibe check --goal "..." --plan "..." --uncertainty "..."',
      {
        goal: "Migrate 50M user records to the new schema before Monday deployment",
        plan: "Run ALTER TABLE to add columns, backfill all rows with UPDATE statements, then DROP the legacy columns to finalize the schema.",
        progress:
          "Schema analysis complete. Migration scripts written. Dry-run tested on 1k rows.",
        uncertainties: [
          "No rollback plan if the migration fails mid-way through the 50M rows",
          "Production data volume untested — dry-run covered only 1k rows",
        ],
      },
      modelOverride,
    );
    printGateResult(checkResult);

    const safeResult = await runCheckStep(
      3,
      "Run a vibe check on a safe plan",
      'vibe check --goal "..." --plan "..."',
      {
        goal: "Migrate 50M user records to the new schema",
        plan: "Write and test a rollback script, dry-run on 1k rows, validate rollback on a 1M-row shadow copy, then execute migration in batches of 100k rows with staged rollout (1% → 10% → 100%) and monitoring.",
        progress:
          "Schema analysis complete. Migration scripts written. Dry-run tested on 1k rows. Rollback script validated on 1M-row shadow copy — full revert confirmed in <30s.",
        uncertainties: [],
      },
      modelOverride,
    );
    printGateResult(safeResult);

    await runLearnStep(demoId);
    printDemoOutro();
  } finally {
    removeLearningEntriesForDemo(demoId);
    resetConstitution(previousRules);
  }
}
