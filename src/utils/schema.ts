import { extractErrorMessage } from "./errors.js";
import { loadProviderSettings, resolveProviderEntry } from "./settings.js";

/**
 * Build the compact agent-facing schema for commands, outputs, and exits.
 *
 * The schema reports the settings-resolved provider and model so agents can
 * inspect runtime configuration without invoking an LLM request.
 */
export function buildSchema() {
  let provider = "unresolved";
  let model = "(settings.json required)";
  try {
    const settings = loadProviderSettings();
    const providerEntry = resolveProviderEntry(settings);
    provider = providerEntry.name;
    model =
      settings.model ?? providerEntry.defaultModel ?? "(required via --model)";
  } catch (error) {
    model = extractErrorMessage(error);
  }
  return {
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
          "--provider": "settings provider entry name",
          "--model": "str",
          "--max-attempts":
            "int (refinement loop limit; fallback: settings.maxAttempts → 10)",
        },
        out: {
          proceed: "bool",
          confidence: "float",
          reason: "str",
          feedback: "str",
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
        req: { "--observation": "str (one sentence)", "--category": "str" },
        opt: {
          "--solution": "str (required unless --type preference)",
          "--type": "mistake|preference|success (default: mistake)",
        },
        out: {
          added: "bool",
          alreadyKnown: "bool",
          categoryCount: "int",
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
      migrate: {
        when: "run database migrations and report schema migration state",
        req: {},
        opt: {},
        out: {
          applied: "[str]",
          pending: "[str]",
          ranAt: "ISO datetime str",
          status: "migrated|up-to-date",
        },
        exit: { "0": "success", "1": "error" },
      },
      "constitution get": {
        when: "inspect active rules before acting",
        req: {},
        out: { session: "str", rules: "[str]" },
      },
      prune: {
        when: "clean up stale or duplicate local data; always report candidates before deleting",
        req: {},
        opt: {
          "--learnings": "target stale learning entries",
          "--duplicates": "target duplicate learning entries",
          "--demos": "target demo-linked learning entries",
          "--sessions": "target stale sessions",
          "--age": "int=90 (days cutoff)",
          "--category": "str (filter by learning category)",
          "--overlap": "float=0.6 (0..1 duplicate threshold)",
          "--dry-run": "report candidates without deleting",
          "-y, --yes": "confirm destructive deletion",
        },
        out: {
          dryRun: "bool",
          targets: "[str]",
          candidateCounts:
            "{learnings:int,duplicates:int,demos:int,sessions:int}",
          representativeDetails:
            "{learnings:[],duplicates:[],demos:[],sessions:[]}",
          backupPath: "str|null",
          deletedCounts:
            "{learnings:int,duplicates:int,demos:int,sessions:int}",
          skippedTargets: "[str]",
          failedTargets: "[{target:str,error:str}]",
        },
        exit: { "0": "success", "1": "error" },
      },
      "skills list": {
        when: "inspect bundled-skill drift against a harness skills directory without mutation",
        req: {},
        opt: {
          "--target": "path (default: ~/.agents/skills)",
        },
        out: {
          target: "absolute path str",
          skills: "[{name:str,status:missing|up-to-date|modified}]",
        },
        exit: { "0": "success", "1": "error" },
      },
      "skills install": {
        when: "opt-in copy of bundled skills into a harness skills directory",
        req: {},
        opt: {
          "--target": "path (default: ~/.agents/skills)",
          "--dry-run": "plan without writing staging or target files",
          "--force":
            "replace every existing bundled target, including hash matches",
        },
        out: {
          target: "absolute path str",
          dryRun: "bool",
          force: "bool",
          ok: "bool",
          skills:
            "[{name:str,status:missing|up-to-date|modified,action:would-install|would-replace|installed|replaced|unchanged|blocked|failed,error?:str}]",
        },
        exit: {
          "0": "success",
          "2": "blocked (modified targets without --force) or failed (partial copy error)",
          "1": "error",
        },
      },
    },
  };
}
