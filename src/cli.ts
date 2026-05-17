#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";

// Load ~/.vibe-cli/.env before anything else, without overriding shell env vars
try {
  const lines = readFileSync(
    join(homedir(), ".vibe-cli", ".env"),
    "utf8",
  ).split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key && val && !process.env[key]) process.env[key] = val;
  }
} catch {}

import {
  getConstitution,
  getCurrentConstitutionSessionId,
  resetConstitution,
  updateConstitution,
} from "./tools/constitution.js";
import { runDemo } from "./tools/demo.js";
import { vibeGateLoop } from "./tools/vibeGate.js";
import { vibeLearnTool } from "./tools/vibeLearn.js";
import { resolveAutosession } from "./utils/autosession.js";
import {
  DEFAULT_MODELS,
  detectProvider,
  verifyConnection,
} from "./utils/llm.js";
import { loadHistory } from "./utils/state.js";

function emit(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data)}\n`);
}

function fatal(message: string): never {
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exit(1);
}

const program = new Command();

program
  .name("vibe")
  .description("Metacognitive AI agent oversight CLI")
  .version("1.0.0");

program
  .command("check")
  .description(
    "Run a metacognitive vibe check — returns feedback and a go/no-go decision",
  )
  .requiredOption("--goal <text>", "Agent goal")
  .requiredOption("--plan <text>", "Agent current plan")
  .option("--progress <text>", "Progress so far")
  .option("--uncertainty <text...>", "Uncertainties (repeatable)")
  .option("--context <text>", "Task context")
  .option("--prompt <text>", "Original user prompt")
  .option(
    "--provider <name>",
    "LLM provider: gemini | openai | openrouter | anthropic | deepseek | opencode",
  )
  .option("--model <name>", "Model name override")
  .option(
    "--max-attempts <n>",
    "Max refinement attempts before giving up",
    "10",
  )
  .action(async (opts) => {
    await loadHistory();
    const result = await vibeGateLoop(
      {
        goal: opts.goal,
        plan: opts.plan,
        progress: opts.progress,
        uncertainties: opts.uncertainty,
        taskContext: opts.context,
        userPrompt: opts.prompt,
        modelOverride:
          opts.provider || opts.model
            ? { provider: opts.provider, model: opts.model }
            : undefined,
      },
      Math.max(1, parseInt(opts.maxAttempts, 10) || 10),
    );
    emit(result);
    if (!result.proceed) process.exit(2);
  });

program
  .command("learn")
  .description("Record a mistake, preference, or success pattern")
  .requiredOption("--mistake <text>", "Pattern to record (one sentence)")
  .requiredOption("--category <name>", "Category label")
  .option("--solution <text>", "How it was or should be resolved")
  .option(
    "--type <type>",
    "Entry type: mistake | preference | success",
    "mistake",
  )
  .action(async (opts) => {
    const result = await vibeLearnTool({
      mistake: opts.mistake,
      category: opts.category,
      solution: opts.solution,
      type: opts.type as "mistake" | "preference" | "success",
    });
    emit(result);
  });

const constitution = program
  .command("constitution")
  .description("Manage per-session constitution rules");

constitution
  .command("set")
  .description("Add one or more rules to the current constitution")
  .requiredOption("--rule <text...>", "Rule(s) to add (repeatable)")
  .action((opts) => {
    const session = getCurrentConstitutionSessionId();
    for (const rule of opts.rule as string[]) {
      updateConstitution(rule);
    }
    emit({ session, rules: getConstitution() });
  });

constitution
  .command("reset")
  .description(
    "Replace all rules for the current constitution (omit --rule to clear)",
  )
  .option("--rule <text...>", "Replacement rules (repeatable)")
  .action((opts) => {
    const session = getCurrentConstitutionSessionId();
    resetConstitution(opts.rule ?? []);
    emit({ session, rules: getConstitution() });
  });

constitution
  .command("get")
  .description("Get the active rules for the current constitution")
  .action(() => {
    const session = getCurrentConstitutionSessionId();
    emit({ session, rules: getConstitution() });
  });

program
  .command("session")
  .description("Emit the active autosession ID for this working directory")
  .action(() => {
    emit({ session: resolveAutosession().id });
  });

program
  .command("verify")
  .description(
    "Test LLM connectivity and report provider, model, latency, and response",
  )
  .option("--provider <name>", "LLM provider override")
  .option("--model <name>", "Model override")
  .action(async (opts) => {
    const result = await verifyConnection({
      provider: opts.provider,
      model: opts.model,
    });
    emit(result);
    if (!result.ok) process.exit(1);
  });

program
  .command("demo")
  .description("Live walkthrough of vibe-check capabilities")
  .option("--session <id>", "Session ID for the demo run", "demo")
  .option("--provider <name>", "LLM provider override")
  .option("--model <name>", "Model override")
  .action(async (opts) => {
    await runDemo({
      sessionId: opts.session,
      modelOverride:
        opts.provider || opts.model
          ? { provider: opts.provider, model: opts.model }
          : undefined,
    });
  });

program
  .command("schema")
  .description("Emit compact JSON schema for agent consumption")
  .action(() => {
    const provider = detectProvider();
    const model =
      process.env.DEFAULT_MODEL ||
      DEFAULT_MODELS[provider] ||
      "(required via --model)";

    emit({
      v: "1.0.0",
      data: "~/.vibe-cli/",
      errors: 'stderr {"error":"msg"} exit 1',
      config: { provider, model },
      commands: {
        check: {
          when: "before any action — especially risky or irreversible ones; halt if proceed is false",
          req: { "--goal": "str", "--plan": "str" },
          opt: {
            "--progress": "str",
            "--uncertainty": "str (repeatable)",
            "--context": "str",
            "--prompt": "str",
            "--provider":
              "gemini|openai|openrouter|anthropic|deepseek|opencode",
            "--model": "str",
            "--max-attempts": "int=10 (refinement loop limit)",
          },
          out: {
            proceed: "bool",
            confidence: "float",
            reason: "str",
            questions: "str",
            plan: "str (final approved or last plan)",
            attempts: "int",
            exhausted: "bool?",
          },
          exit: {
            "0": "proceed=true",
            "2": "proceed=false or exhausted",
            "1": "error",
          },
        },
        learn: {
          when: "after completing a task; when a mistake, preference, or success is observed",
          req: { "--mistake": "str (one sentence)", "--category": "str" },
          opt: {
            "--solution": "str (required unless --type preference)",
            "--type": "mistake|preference|success (default: mistake)",
          },
          out: {
            added: "bool",
            alreadyKnown: "bool",
            currentTally: "int",
            topCategories: "[{category,count,recentExample}]",
          },
        },
        "constitution set": {
          when: "establish behavioral rules for the current session before work begins",
          req: { "--rule": "str (repeatable)" },
          out: { session: "str", rules: "[str]" },
        },
        "constitution reset": {
          when: "replace or clear all rules for the current session",
          req: {},
          opt: { "--rule": "str (repeatable, omit to clear all)" },
          out: { session: "str", rules: "[str]" },
        },
        session: {
          when: "inspect the active autosession ID for the current working directory",
          req: {},
          out: { session: "str" },
        },
        verify: {
          when: "preflight check before using vibe check in a new environment",
          req: {},
          opt: { "--provider": "str", "--model": "str" },
          out: {
            ok: "bool",
            provider: "str",
            model: "str",
            latency_ms: "int?",
            response: "str?",
            error: "str?",
          },
        },
        "constitution get": {
          when: "inspect active rules before acting",
          req: {},
          out: { session: "str", rules: "[str]" },
        },
      },
    });
  });

program.parseAsync(process.argv).catch((e: Error) => fatal(e.message));
