#!/usr/bin/env bun
import { Command } from "commander";
import { loadDotenv } from "./utils/dotenv.js";

loadDotenv();

/**
 * Register the `vibe` command surface and preserve JSON-only process output.
 *
 * All command handlers emit machine-readable JSON, with operational failures
 * routed through `fatal` so agents can parse errors without scraping text.
 */
import {
  getConstitution,
  getCurrentConstitutionSessionId,
  resetConstitution,
  updateConstitution,
} from "./tools/constitution.js";
import { runDemo } from "./tools/demo.js";
import { runPrune } from "./tools/prune.js";
import { vibeGateLoop } from "./tools/vibeGate.js";
import { vibeLearnTool } from "./tools/vibeLearn.js";
import { resolveAutosession } from "./utils/autosession.js";
import { openVibeDatabaseWithMigrationReport } from "./utils/database.js";
import {
  formatListAll,
  formatListCategories,
  formatListChecks,
  formatListCommandOverview,
  formatListConstitution,
  formatListLearnings,
  formatListProviders,
  formatListSessions,
  formatListStats,
  parseLearningType,
  parseListLimit,
  readListAll,
  readListCategories,
  readListChecks,
  readListConstitution,
  readListLearnings,
  readListProviders,
  readListSessions,
  readListStats,
  toListOverviewJson,
  toProvidersJson,
} from "./utils/listData.js";
import { verifyConnection } from "./utils/llm.js";
import { buildSchema } from "./utils/schema.js";

/** Emit one JSON payload to stdout for successful command responses. */
function emit(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data)}\n`);
}

/** Emit a fatal JSON error to stderr and terminate with exit code 1. */
function fatal(message: string): never {
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exit(1);
}

function addModelOptions(cmd: Command) {
  return cmd
    .option(
      "--provider <name>",
      "LLM provider: gemini | openai | openrouter | anthropic | deepseek | opencode",
    )
    .option("--model <name>", "Model name override");
}

function resolveModelOverride(opts: { provider?: string; model?: string }) {
  return opts.provider || opts.model
    ? {
        modelOverride: {
          ...(opts.provider !== undefined && { provider: opts.provider }),
          ...(opts.model !== undefined && { model: opts.model }),
        },
      }
    : {};
}

function emitListResult<T>(command: Command, data: T, pretty: string): void {
  if ((command.optsWithGlobals() as { json?: boolean }).json) {
    emit(data);
    return;
  }
  process.stdout.write(pretty.endsWith("\n") ? pretty : `${pretty}\n`);
}

/**
 * Register a list subcommand with consistent `--json` option handling.
 *
 * The action receives the parsed Commander options and the command instance,
 * then calls `emitListResult` with the JSON data and pretty-formatted text.
 */
function registerListCommand(
  parent: Command,
  name: string,
  description: string,
  extraOptions: Array<{ flags: string; description: string }> = [],
  action: (
    opts: Record<string, string | undefined>,
    command: Command,
  ) => { data: unknown; pretty: string },
): Command {
  const cmd = parent.command(name).description(description);
  for (const opt of extraOptions) {
    cmd.option(opt.flags, opt.description);
  }
  cmd.option("--json", "Emit machine-readable JSON instead of pretty text");
  cmd.action((opts: Record<string, string | undefined>, command: Command) => {
    const { data, pretty } = action(opts, command);
    emitListResult(command, data, pretty);
  });
  return cmd;
}

/**
 * Build a list command action from read and format functions.
 *
 * @param readFn - Function that retrieves data, optionally with parsed options.
 * @param formatFn - Function that formats data for pretty output.
 * @param parseOpts - Optional function to parse Commander options into read function params.
 * @param transformFn - Optional function to transform data for JSON output.
 */
function buildListAction<T, P = void>(
  readFn: (params?: P) => T,
  formatFn: (data: T) => string,
  parseOpts?: (opts: Record<string, string | undefined>) => P,
  transformFn?: (data: T) => unknown,
) {
  return (opts: Record<string, string | undefined>) => {
    const params = parseOpts?.(opts);
    const data = readFn(params);
    return {
      data: transformFn ? transformFn(data) : data,
      pretty: formatFn(data),
    };
  };
}

/** Configuration for list subcommands. */
const LIST_COMMANDS = [
  {
    name: "learnings",
    description: "List stored learning entries",
    options: [
      {
        flags: "--type <type>",
        description: "Filter by type: mistake | preference | success",
      },
      { flags: "--category <name>", description: "Filter by category" },
      { flags: "--limit <n>", description: "Limit rows after filtering" },
    ],
    action: buildListAction(readListLearnings, formatListLearnings, (opts) => {
      const type = parseLearningType(opts.type);
      const limit = parseListLimit(opts.limit);
      return {
        ...(type !== undefined && { type }),
        ...(opts.category !== undefined && { category: opts.category }),
        ...(limit !== undefined && { limit }),
      };
    }),
  },
  {
    name: "constitution",
    description: "List active constitution rules",
    options: [],
    action: buildListAction(readListConstitution, formatListConstitution),
  },
  {
    name: "sessions",
    description: "List local autosessions",
    options: [],
    action: buildListAction(readListSessions, formatListSessions),
  },
  {
    name: "providers",
    description: "List static provider model defaults",
    options: [],
    action: buildListAction(
      readListProviders,
      (state) => formatListProviders(state),
      undefined,
      toProvidersJson,
    ),
  },
  {
    name: "checks",
    description: "List stored vibe-check records",
    options: [
      { flags: "--session <id>", description: "Filter by session id" },
      { flags: "--limit <n>", description: "Limit rows after filtering" },
    ],
    action: buildListAction(readListChecks, formatListChecks, (opts) => {
      const limit = parseListLimit(opts.limit);
      return {
        ...(opts.session !== undefined && { session: opts.session }),
        ...(limit !== undefined && { limit }),
      };
    }),
  },
  {
    name: "categories",
    description: "List learning category counts",
    options: [],
    action: buildListAction(readListCategories, formatListCategories),
  },
  {
    name: "stats",
    description: "List aggregate local data stats",
    options: [],
    action: buildListAction(readListStats, formatListStats),
  },
  {
    name: "all",
    description: "List every local data surface",
    options: [],
    action: buildListAction(readListAll, formatListAll),
  },
] as const;

const program = new Command();

program
  .name("vibe")
  .description("Metacognitive AI agent oversight CLI")
  .version("1.0.0")
  .exitOverride((error) => {
    if (error.exitCode === 0) process.exit(0);
    throw error;
  })
  .configureOutput({ writeErr: () => {} });

const checkCmd = program
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
    "--max-attempts <n>",
    "Max refinement attempts before giving up",
    process.env.VIBE_MAX_ATTEMPTS ?? "10",
  );
addModelOptions(checkCmd);
checkCmd.action(async (opts) => {
  const result = await vibeGateLoop(
    {
      goal: opts.goal,
      plan: opts.plan,
      ...(opts.progress !== undefined && { progress: opts.progress }),
      ...(opts.uncertainty !== undefined && {
        uncertainties: opts.uncertainty,
      }),
      ...(opts.context !== undefined && { taskContext: opts.context }),
      ...(opts.prompt !== undefined && { userPrompt: opts.prompt }),
      ...resolveModelOverride(opts),
    },
    Math.max(1, parseInt(opts.maxAttempts, 10) || 10),
  );
  emit(result);
  if (!result.proceed) process.exit(2);
});

program
  .command("learn")
  .description("Record a mistake, preference, or success pattern")
  .requiredOption("--observation <text>", "Pattern to record (one sentence)")
  .requiredOption("--category <name>", "Category label")
  .option("--solution <text>", "How it was or should be resolved")
  .option(
    "--type <type>",
    "Entry type: mistake | preference | success",
    "mistake",
  )
  .action(async (opts) => {
    const result = await vibeLearnTool({
      observation: opts.observation,
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
  .command("migrate")
  .description("Run database migrations and emit schema migration state")
  .action(() => {
    const { database, report } = openVibeDatabaseWithMigrationReport();
    database.close();
    emit(report);
  });

const verifyCmd = program
  .command("verify")
  .description(
    "Test LLM connectivity and report provider, model, latency, and response",
  );
addModelOptions(verifyCmd);
verifyCmd.action(async (opts) => {
  const result = await verifyConnection({
    provider: opts.provider,
    model: opts.model,
  });
  emit(result);
  if (!result.ok) process.exit(1);
});

const demoCmd = program
  .command("demo")
  .description("Live walkthrough of vibe-check capabilities");
addModelOptions(demoCmd);
demoCmd.action(async (opts) => {
  await runDemo(resolveModelOverride(opts));
});

const list = program
  .command("list")
  .description("List local stored data and static provider configuration")
  .option("--json", "Emit machine-readable JSON instead of pretty text");
list.action(() => {
  emitListResult(list, toListOverviewJson(), formatListCommandOverview());
});

// Register list subcommands from configuration.
for (const cmd of LIST_COMMANDS) {
  registerListCommand(
    list,
    cmd.name,
    cmd.description,
    [...cmd.options],
    cmd.action,
  );
}

program
  .command("prune")
  .description("Report or delete local prune candidates with backup safeguards")
  .option("--learnings", "Target stale learning entries")
  .option("--duplicates", "Target duplicate learning entries")
  .option("--demos", "Target demo-linked learning entries")
  .option("--sessions", "Target stale sessions")
  .option("--age <days>", "Age cutoff in days (default: 90)")
  .option("--category <name>", "Filter by learning category")
  .option(
    "--overlap <float>",
    "Duplicate overlap threshold (0..1, default: 0.6)",
  )
  .option("--dry-run", "Report candidates without deleting")
  .option("-y, --yes", "Confirm destructive deletion")
  .action((opts) => {
    const age = opts.age !== undefined ? parseInt(opts.age, 10) : undefined;
    if (age !== undefined && Number.isNaN(age))
      fatal("--age must be a valid integer");
    const overlap =
      opts.overlap !== undefined ? parseFloat(opts.overlap) : undefined;
    if (overlap !== undefined && Number.isNaN(overlap))
      fatal("--overlap must be a valid number between 0 and 1");
    const result = runPrune({
      ...(opts.learnings && { learnings: opts.learnings }),
      ...(opts.duplicates && { duplicates: opts.duplicates }),
      ...(opts.demos && { demos: opts.demos }),
      ...(opts.sessions && { sessions: opts.sessions }),
      ...(age !== undefined && { age }),
      ...(opts.category !== undefined && { category: opts.category }),
      ...(overlap !== undefined && { overlap }),
      ...(opts.dryRun && { dryRun: opts.dryRun }),
      ...(opts.yes && { yes: opts.yes }),
    });
    emit(result);
  });

program
  .command("schema")
  .description("Emit compact JSON schema for agent consumption")
  .action(() => emit(buildSchema()));

program.parseAsync(process.argv).catch((e: Error) => fatal(e.message));
