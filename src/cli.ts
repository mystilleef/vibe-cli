#!/usr/bin/env bun
/**
 * Register the `vibe` command surface with mixed text/JSON process output.
 *
 * Human-facing commands (`list`, `skills`, `guide`, `settings install`,
 * `prune`, `doctor`, `tldr`) print readable text by default and emit JSON under
 * `--json`; agent-loop commands always emit JSON. Operational failures route
 * through `fatal` as one stderr JSON error line so agents can parse errors
 * without scraping text.
 */
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import tldrPageText from "../docs/tldr.md" with { type: "text" };
import packageJson from "../package.json" with { type: "json" };
import { resetConstitution, updateConstitution } from "./tools/constitution.js";
import { runDemo } from "./tools/demo.js";
import { doctorResultIndicatesFailure, runDoctor } from "./tools/doctor.js";
import { installGuide } from "./tools/guideInstaller.js";
import { runPrune } from "./tools/prune.js";
import { installSettings } from "./tools/settingsInstaller.js";
import { installSkills } from "./tools/skillsInstaller.js";
import { vibeGateLoop } from "./tools/vibeGate.js";
import { vibeLearnTool } from "./tools/vibeLearn.js";
import { resolveAutosession } from "./utils/autosession.js";
import {
  type CliResult,
  emitTestErrorMarker,
  runCapturedInvocation,
  setExitCode,
} from "./utils/cliCapture.js";
import {
  CWD_TARGET_DESCRIPTION,
  DRY_RUN_DESCRIPTION,
  JSON_OPTION_DESCRIPTION,
  JSON_OPTION_FLAG,
  PROVIDER_OPTION_DESCRIPTION,
  SETTINGS_FORCE_DESCRIPTION,
  SKILLS_FORCE_DESCRIPTION,
  SKILLS_TARGET_DESCRIPTION,
} from "./utils/cliConstants.js";
import {
  buildCheckParams,
  buildPruneParams,
  isTldrInvocation,
  resolveModelOverride,
} from "./utils/cliHelpers.js";
import { openVibeDatabaseWithMigrationReport } from "./utils/database.js";
import { getDataRoot } from "./utils/db-core.js";
import {
  formatDoctorReport,
  formatPruneReport,
} from "./utils/doctorPruneFormatters.js";
import { warnLegacyDotenv } from "./utils/dotenv.js";
import { extractErrorMessage } from "./utils/errors.js";
import { inspectGuide } from "./utils/guide.js";
import type { LearningType } from "./utils/learningEntryCore.js";
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
import { loadProviderSettings } from "./utils/settings.js";
import {
  formatSettingsInstall,
  maybeAppendProviderGuidance,
} from "./utils/settingsInstallFormatters.js";
import { computeSkillsInventory, resolveTargetRoot } from "./utils/skills.js";
import {
  formatGuideInstall,
  formatGuideList,
  formatSkillsInstall,
  formatSkillsList,
} from "./utils/skillsGuideFormatters.js";
import { formatTldr, parseTldr } from "./utils/tldr.js";

/** Emit one JSON payload to stdout for successful command responses. */
function emit(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data)}\n`);
}

/** Emit a fatal JSON error to stderr and terminate with exit code 1. */
function fatal(message: string): never {
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exit(1);
}

/**
 * Wrap an action with the standard CLI error-handling pattern.
 * On error, emits a JSON diagnostic to stderr and calls `fatal`.
 * Passes through all arguments so Commander can inject `opts`.
 */
function withCliError<A extends unknown[]>(
  action: (...args: A) => void | Promise<void>,
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await action(...args);
    } catch (e) {
      fatal(extractErrorMessage(e));
    }
  };
}

function addModelOptions(cmd: Command) {
  return cmd
    .option("--provider <name>", PROVIDER_OPTION_DESCRIPTION)
    .option("--model <name>", "Model name override");
}

/** Parsed Commander option bag passed to list actions. */
type CliOptions = Record<string, string | undefined>;

function emitListResult<T>(command: Command, data: T, pretty: string): void {
  if (command.optsWithGlobals()["json"]) {
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
  extraOptions: readonly { flags: string; description: string }[] = [],
  action: (
    opts: CliOptions,
    command: Command,
  ) => { data: unknown; pretty: string },
): Command {
  const cmd = parent.command(name).description(description);
  for (const opt of extraOptions) {
    cmd.option(opt.flags, opt.description);
  }
  cmd.option(JSON_OPTION_FLAG, JSON_OPTION_DESCRIPTION);
  cmd.action((opts: CliOptions, command: Command) => {
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
  parseOpts?: (opts: CliOptions) => P,
  transformFn?: (data: T) => unknown,
) {
  return (opts: CliOptions) => {
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
      const type = parseLearningType(opts["type"]);
      const limit = parseListLimit(opts["limit"]);
      return {
        ...(type !== undefined && { type }),
        ...(opts["category"] !== undefined && { category: opts["category"] }),
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
    description: "List configured provider model defaults",
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
      const limit = parseListLimit(opts["limit"]);
      return {
        ...(opts["session"] !== undefined && { session: opts["session"] }),
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
  .version(packageJson.version)
  .exitOverride((error) => {
    if (error.exitCode === 0) process.exit(0);
    throw error;
  })
  .configureOutput({ writeErr: () => {} });

program.addHelpText("after", "\nRun `vibe tldr` for quick examples.\n");

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
  .option("--max-attempts <n>", "Max refinement attempts before giving up");
addModelOptions(checkCmd);
checkCmd.action(
  withCliError(async (opts) => {
    let settingsMaxAttempts: number | undefined;
    try {
      settingsMaxAttempts = loadProviderSettings().maxAttempts;
    } catch {
      // Graceful degradation: missing/invalid settings fall through to env/default
    }
    const { params, maxAttempts } = buildCheckParams(opts, settingsMaxAttempts);
    const result = await vibeGateLoop(params, maxAttempts);
    emit(result);
    if (!result.proceed) process.exit(2);
  }),
);

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
  .action(
    withCliError(async (opts) => {
      emit(
        await vibeLearnTool({
          observation: opts.observation,
          category: opts.category,
          solution: opts.solution,
          type: opts.type as LearningType,
        }),
      );
    }),
  );

const constitution = program
  .command("constitution")
  .description("Manage per-session constitution rules");

constitution
  .command("set")
  .description("Add one or more rules to the current constitution")
  .requiredOption("--rule <text...>", "Rule(s) to add (repeatable)")
  .action(
    withCliError((opts) => {
      for (const rule of opts.rule as string[]) {
        updateConstitution(rule);
      }
      emit(readListConstitution());
    }),
  );

constitution
  .command("reset")
  .description(
    "Replace all rules for the current constitution (omit --rule to clear)",
  )
  .option("--rule <text...>", "Replacement rules (repeatable)")
  .action(
    withCliError((opts) => {
      resetConstitution(opts.rule ?? []);
      emit(readListConstitution());
    }),
  );

constitution
  .command("get")
  .description("Get the active rules for the current constitution")
  .action(
    withCliError(() => {
      emit(readListConstitution());
    }),
  );

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
  .description("List local stored data and configured providers")
  .option(JSON_OPTION_FLAG, JSON_OPTION_DESCRIPTION);
list.action(() => {
  emitListResult(list, toListOverviewJson(), formatListCommandOverview());
});

// Register list subcommands from configuration.
for (const cmd of LIST_COMMANDS) {
  registerListCommand(list, cmd.name, cmd.description, cmd.options, (opts) =>
    cmd.action(opts),
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
  .option(
    "-y, --yes",
    "Confirm deletion; without target flags, delete every target",
  )
  .option(JSON_OPTION_FLAG, JSON_OPTION_DESCRIPTION)
  .addHelpText(
    "after",
    `
Reports candidates and outcomes as readable text without deleting; pass --json
for the machine-readable payload fields instead.
Deletion applies only with --yes (bare --yes deletes every target) after one
safety backup. Under --json, backupPath names that safety backup and
failedTargets lists {target, message}.`,
  )
  .action(
    withCliError(async (opts: Record<string, unknown>, command: Command) => {
      const { params } = buildPruneParams(opts);
      const result = await runPrune(params);
      emitListResult(command, result, formatPruneReport(result));
    }),
  );

program
  .command("doctor")
  .description(
    "Local-state health and maintenance; provider-free, backup-first",
  )
  .option("--vacuum", "Reclaim free pages after the safety backup")
  .option("--purge-backups", "Delete retired managed backups beyond retention")
  .option("--purge-legacy", "Delete recorded legacy .bak copies")
  .option("--keep-backups <n>", "Retain newest managed backups (default: five)")
  .option(
    "-y, --yes",
    "Apply selected targets (all without target flags) after one safety backup",
  )
  .option(JSON_OPTION_FLAG, JSON_OPTION_DESCRIPTION)
  .addHelpText(
    "after",
    `
Reports findings as readable text without changing local data; pass --json
for the machine-readable payload fields instead.
Maintenance applies only with --yes (bare --yes applies every target), after
one safety backup. Under --json, findings keep pre-application values while
backupPath names the new safety backup. When targets include purgeBackups,
excessBackups counts that pending backup, predicting appliedCounts.purgeBackups;
appliedCounts.vacuum reports reclaimed free pages.
Exit 0 covers healthy reports and applies, including harmless no-ops. Exit 1
covers unhealthy diagnostics, backup or target failures, and operational
errors; failures report {target, message}.`,
  )
  .action(
    withCliError(
      async (
        opts: Record<string, string | boolean | undefined>,
        command: Command,
      ) => {
        const keepBackups = opts["keepBackups"];
        const result = await runDoctor({
          vacuum: opts["vacuum"] === true,
          purgeBackups: opts["purgeBackups"] === true,
          purgeLegacy: opts["purgeLegacy"] === true,
          ...(typeof keepBackups === "string" && { keepBackups }),
          yes: opts["yes"] === true,
        });
        const healthy = !doctorResultIndicatesFailure(result);
        emitListResult(command, result, formatDoctorReport(result, healthy));
        if (!healthy) setExitCode(1);
      },
    ),
  );

program
  .command("schema")
  .description("Emit compact JSON schema for agent consumption")
  .action(() => {
    emit(buildSchema());
  });

const tldr = program
  .command("tldr")
  .description("Print the offline workflow cheat sheet (12 quick examples)")
  .option(JSON_OPTION_FLAG, JSON_OPTION_DESCRIPTION);
tldr.action(() => {
  const page = parseTldr(tldrPageText);
  // Color stays resolved at the action edge: styling needs a real terminal
  // and an unset or empty NO_COLOR; JSON output never carries styling.
  const color =
    process.stdout.isTTY === true && (process.env["NO_COLOR"] ?? "") === "";
  emitListResult(tldr, page, formatTldr(page, { color }));
});

const skills = program
  .command("skills")
  .description("Inspect or install bundled skills");

skills
  .command("list")
  .description(
    "Inspect bundled-skill drift against a harness skills directory without mutation",
  )
  .option("--target <path>", SKILLS_TARGET_DESCRIPTION)
  .option(JSON_OPTION_FLAG, JSON_OPTION_DESCRIPTION)
  .action(
    withCliError((opts, command: Command) => {
      const target = resolveTargetRoot(opts.target);
      const inventory = computeSkillsInventory(target, {});
      const result = {
        target: inventory.targetRoot,
        skills: inventory.skills.map((s) => ({
          name: s.name,
          status: s.status,
        })),
      };
      emitListResult(command, result, formatSkillsList(result));
    }),
  );

skills
  .command("install")
  .description("Opt-in copy of bundled skills into a harness skills directory")
  .option("--target <path>", SKILLS_TARGET_DESCRIPTION)
  .option("--dry-run", DRY_RUN_DESCRIPTION)
  .option("--force", SKILLS_FORCE_DESCRIPTION)
  .option(JSON_OPTION_FLAG, JSON_OPTION_DESCRIPTION)
  .action(
    withCliError(async (opts, command: Command) => {
      const target = resolveTargetRoot(opts.target);
      const result = await installSkills(target, {
        dryRun: Boolean(opts.dryRun),
        force: Boolean(opts.force),
      });
      emitListResult(command, result, formatSkillsInstall(result));
      if (!result.ok) process.exit(2);
    }),
  );

const guide = program
  .command("guide")
  .description("Inspect or install the bundled guide");

guide
  .command("list")
  .description(
    "Inspect guide drift against a target directory without mutation",
  )
  .option("--target <path>", CWD_TARGET_DESCRIPTION)
  .option(JSON_OPTION_FLAG, JSON_OPTION_DESCRIPTION)
  .action(
    withCliError((opts, command: Command) => {
      const target = opts.target ?? process.cwd();
      const inspection = inspectGuide(target);
      const result = {
        target: inspection.target,
        status: inspection.status,
      };
      emitListResult(command, result, formatGuideList(result));
    }),
  );

guide
  .command("install")
  .description("Install or update the bundled guide into a target directory")
  .option("--target <path>", CWD_TARGET_DESCRIPTION)
  .option("--dry-run", DRY_RUN_DESCRIPTION)
  .option(JSON_OPTION_FLAG, JSON_OPTION_DESCRIPTION)
  .action(
    withCliError(async (opts, command: Command) => {
      const target = opts.target ?? process.cwd();
      const result = await installGuide(target, {
        dryRun: Boolean(opts.dryRun),
      });
      emitListResult(command, result, formatGuideInstall(result));
    }),
  );

const settings = program
  .command("settings")
  .description("Install bundled settings template");

settings
  .command("install")
  .description("Install the bundled settings.example.json into the data root")
  .option("--dry-run", DRY_RUN_DESCRIPTION)
  .option("--force", SETTINGS_FORCE_DESCRIPTION)
  .option(JSON_OPTION_FLAG, JSON_OPTION_DESCRIPTION)
  .action(
    withCliError(async (opts, command: Command) => {
      const result = await installSettings("~/.vibe-cli", {
        dryRun: Boolean(opts.dryRun),
        force: Boolean(opts.force),
        dataRoot: getDataRoot(),
      });
      const pretty = formatSettingsInstall(result);
      const prettyWithGuidance = maybeAppendProviderGuidance(result, pretty);
      emitListResult(command, result, prettyWithGuidance);
    }),
  );

/**
 * Run the CLI in-process, capturing stdout and stderr.
 * Used by tests to avoid spawning a subprocess.
 *
 * Uses AsyncLocalStorage to scope capture to each invocation,
 * enabling safe concurrent calls without global handler crosstalk.
 *
 * @param args - CLI arguments
 * @param testErrorMarker - Optional marker to emit via console.error (test seam)
 * @param coordinationCallback - Optional async callback that yields before marker emission (test seam)
 */
export async function runCliInProcess(
  args: string[],
  testErrorMarker?: string,
  coordinationCallback?: () => Promise<void>,
): Promise<CliResult> {
  return runCapturedInvocation(async (capture) => {
    // Legacy .env diagnostics stay invocation-local: only a `tldr` root
    // command exempts itself, resolved from this run's own args.
    if (!isTldrInvocation(args)) {
      warnLegacyDotenv((data: string) => {
        capture.appendStderr(data);
      });
    }

    // Yield if coordination callback provided (test seam for post-await isolation)
    if (coordinationCallback !== undefined) {
      await coordinationCallback();
    }

    // Emit test error marker if provided (test seam for deterministic async marker emission)
    if (testErrorMarker !== undefined) {
      console.error(testErrorMarker);
    } else {
      emitTestErrorMarker();
    }

    try {
      await program.parseAsync(["node", "bun", ...args]);
    } catch (e: unknown) {
      // Commander throws on --help/--version or validation errors
      const err = e as Error & { exitCode?: number };
      if (
        err instanceof Error &&
        (err.exitCode === 0 || /^\(output/.test(err.message))
      ) {
        // Help/version output — stdout already captured
        setExitCode(0);
      } else if (err instanceof Error) {
        capture.appendStderr(`${JSON.stringify({ error: err.message })}\n`);
        setExitCode(1);
      } else {
        capture.appendStderr(`${JSON.stringify({ error: String(e) })}\n`);
        setExitCode(1);
      }
    }
  });
}

// Legacy .env diagnostics follow the invocation: plain imports keep the
// existing module-load warning, and direct runs warn unless their root
// command is `tldr`. `isDirectCliEntry` is a hoisted declaration.
const directEntryArgs = isDirectCliEntry(process.argv[1], import.meta.url)
  ? process.argv.slice(2)
  : undefined;
if (directEntryArgs === undefined || !isTldrInvocation(directEntryArgs)) {
  warnLegacyDotenv();
}

/**
 * True when `moduleUrl` (an `import.meta.url`) refers to the same file as
 * `argv1` (a raw `process.argv[1]` filesystem path), distinguishing direct
 * execution (`bun run cli.ts`) from a plain import. Pure — `pathToFileURL`
 * only percent-encodes the path, it performs no filesystem access.
 */
export function isDirectCliEntry(
  argv1: string | undefined,
  moduleUrl: string,
): boolean {
  return argv1 !== undefined && moduleUrl === pathToFileURL(argv1).href;
}

// Only run CLI when executed directly, not when imported.
if (isDirectCliEntry(process.argv[1], import.meta.url)) {
  program.parseAsync(process.argv).catch((e: Error) => fatal(e.message));
}
