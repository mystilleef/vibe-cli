import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCwdKey } from "../src/utils/autosession";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome";

const homes: TempHomeContext[] = [];
const cwdRoots: string[] = [];
const originalCwd = process.cwd();
const cli = join(originalCwd, "src", "cli.ts");
const mockAnthropicFetch = join(
  originalCwd,
  "tests",
  "helpers",
  "mockAnthropicFetch.ts",
);

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(
    cwdRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
  await Promise.all(homes.splice(0).map((home) => home.cleanup()));
});

async function useTempHome(): Promise<TempHomeContext> {
  const home = await createTempHome();
  homes.push(home);
  return home;
}

async function createCwd(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "vibe-cli-surface-"));
  cwdRoots.push(cwd);
  return cwd;
}

function runCli(
  args: string[],
  options: {
    cwd?: string;
    home?: string;
    env?: Record<string, string | undefined>;
    preload?: string;
  } = {},
): CliResult {
  const env: Record<string, string> = {
    ...process.env,
    HOME: options.home ?? process.env.HOME ?? "",
  };
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  const result = Bun.spawnSync({
    cmd: [
      "bun",
      "run",
      ...(options.preload === undefined ? [] : ["--preload", options.preload]),
      cli,
      ...args,
    ],
    cwd: options.cwd ?? originalCwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  };
}

function expectHelpWithoutSession(command: string[]): void {
  const result = runCli([...command, "--help"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).not.toContain("--session");
}

/** Shared check-runner — reduces boilerplate across max-attempts tests. */
async function runVibeCheck(
  extraArgs: string[] = [],
  extraEnv: Record<string, string | undefined> = {},
): Promise<{
  result: CliResult;
  payload: Record<string, unknown>;
}> {
  const home = await useTempHome();
  const result = runCli(
    [
      "check",
      "--goal",
      "ship safely",
      "--plan",
      "run targeted tests",
      "--provider",
      "anthropic",
      ...extraArgs,
    ],
    {
      home: home.home,
      preload: mockAnthropicFetch,
      env: {
        ANTHROPIC_API_KEY: "ak",
        DEFAULT_MODEL: undefined,
        ...extraEnv,
      },
    },
  );
  return {
    result,
    payload: JSON.parse(result.stdout) as Record<string, unknown>,
  };
}

describe("CLI autosession surface", () => {
  test("production storage modules do not import legacy migration helpers", async () => {
    const productionModules = [
      "src/utils/autosession.ts",
      "src/utils/storage.ts",
      "src/utils/state.ts",
      "src/tools/constitution.ts",
      "src/cli.ts",
    ];

    for (const modulePath of productionModules) {
      const source = await readFile(join(originalCwd, modulePath), "utf8");
      expect(source).not.toContain("legacyMigration");
      expect(source).not.toContain("vibe-log.json");
      expect(source).not.toContain("constitution.json");
      expect(source).not.toContain("history.json");
    }
  });

  test("affected help output omits public --session options", () => {
    expectHelpWithoutSession(["check"]);
    expectHelpWithoutSession(["learn"]);
    expectHelpWithoutSession(["constitution", "set"]);
    expectHelpWithoutSession(["constitution", "get"]);
    expectHelpWithoutSession(["constitution", "reset"]);

    expectHelpWithoutSession(["demo"]);
  });

  test("removed --session options fail through Commander", () => {
    for (const command of [
      ["check", "--session", "x", "--goal", "g", "--plan", "p"],
      ["learn", "--session", "x", "--mistake", "m", "--category", "c"],
      ["constitution", "set", "--session", "x", "--rule", "r"],
      ["constitution", "get", "--session", "x"],
      ["constitution", "reset", "--session", "x"],
      ["demo", "--session", "x"],
    ]) {
      const result = runCli(command);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("unknown option '--session'");
    }
  });

  test("session command emits JSON and refreshes lastAccessedAt", async () => {
    const home = await useTempHome();
    const cwd = await createCwd();
    const cwdKey = getCwdKey(cwd);

    const first = runCli(["session"], { cwd, home: home.home });
    const firstJson = JSON.parse(first.stdout) as { session: string };
    const db = new Database(join(home.dataRoot, "vibe.db"));
    const oldTimestamp = new Date(Date.now() - 1000).toISOString();
    db.prepare(
      "UPDATE sessions SET last_accessed_at = ? WHERE cwd_key = ?",
    ).run(oldTimestamp, cwdKey);

    const second = runCli(["session"], { cwd, home: home.home });
    const secondJson = JSON.parse(second.stdout) as { session: string };
    const touched = db
      .query<{ last_accessed_at: string }, [string]>(
        "SELECT last_accessed_at FROM sessions WHERE cwd_key = ?",
      )
      .get(cwdKey);
    db.close();

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(firstJson.session).toMatch(/^[0-9a-f-]{36}$/);
    expect(secondJson.session).toBe(firstJson.session);
    expect(touched).not.toBeNull();
    expect(Date.parse(touched?.last_accessed_at ?? "")).toBeGreaterThan(
      Date.parse(oldTimestamp),
    );
  });

  test("schema reflects session command and removed public session flags", () => {
    const result = runCli(["schema"]);
    const schema = JSON.parse(result.stdout) as {
      commands: Record<string, { opt?: Record<string, string> }>;
    };

    expect(Object.keys(schema.commands)).toContain("session");
    for (const command of [
      "check",
      "learn",
      "constitution set",
      "constitution get",
      "constitution reset",
    ]) {
      expect(schema.commands[command]?.opt ?? {}).not.toHaveProperty(
        "--session",
      );
    }
  });

  test("schema loads home env file without overriding shell env vars", async () => {
    const home = await useTempHome();
    await mkdir(home.dataRoot, { recursive: true });
    await writeFile(
      join(home.dataRoot, ".env"),
      [
        "# ignored comment",
        "DEFAULT_LLM_PROVIDER=deepseek",
        "DEFAULT_MODEL=file-model",
        "MALFORMED_LINE",
        "EMPTY_VALUE=",
      ].join("\n"),
    );

    const result = runCli(["schema"], {
      home: home.home,
      env: {
        DEFAULT_LLM_PROVIDER: undefined,
        DEFAULT_MODEL: "shell-model",
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_AUTH_TOKEN: undefined,
        GEMINI_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        OPENROUTER_API_KEY: undefined,
        DEEPSEEK_API_KEY: undefined,
        OPENCODE_API_KEY: undefined,
      },
    });
    const schema = JSON.parse(result.stdout) as {
      config: { provider: string; model: string };
    };

    expect(result.exitCode).toBe(0);
    expect(schema.config).toEqual({
      provider: "deepseek",
      model: "shell-model",
    });
  });

  test("verify emits JSON failure and exits 1 for unsupported providers", async () => {
    const home = await useTempHome();

    const result = runCli(["verify", "--provider", "bogus"], {
      home: home.home,
      env: { DEFAULT_MODEL: undefined },
    });
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      provider: string;
      model: string;
      error: string;
    };

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(payload).toMatchObject({
      ok: false,
      provider: "bogus",
      model: "(default)",
    });
    expect(payload.error).toContain("Unknown provider: bogus");
  });

  test("check emits fatal JSON when gate provider resolution fails", async () => {
    const home = await useTempHome();

    const result = runCli(
      ["check", "--goal", "g", "--plan", "p", "--provider", "bogus"],
      { home: home.home, env: { DEFAULT_MODEL: undefined } },
    );
    const payload = JSON.parse(result.stderr) as { error: string };

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(payload.error).toContain("Unknown provider: bogus");
  });

  test("check emits approval JSON and exits 0 with mocked Anthropic", async () => {
    const { result, payload } = await runVibeCheck(
      [
        "--model",
        "mock-claude",
        "--progress",
        "implementation done",
        "--uncertainty",
        "edge cases",
        "--context",
        "release prep",
        "--prompt",
        "please verify",
      ],
      { VIBE_TEST_ANTHROPIC_MODE: "proceed" },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(payload).toMatchObject({
      proceed: true,
      confidence: 0.91,
      reason: "proceed:mock-claude",
      attempts: 1,
    });
    expect(payload.questions).toContain("questions:mock-claude");
  });

  test("VIBE_MAX_ATTEMPTS env var sets default max attempts", async () => {
    const { result, payload } = await runVibeCheck([], {
      VIBE_MAX_ATTEMPTS: "1",
      VIBE_TEST_ANTHROPIC_MODE: "block",
    });

    expect(result.exitCode).toBe(2);
    expect(payload).toMatchObject({
      proceed: false,
      exhausted: true,
      attempts: 1,
    });
  });

  test("--max-attempts flag overrides VIBE_MAX_ATTEMPTS env var", async () => {
    const { result, payload } = await runVibeCheck(
      ["--model", "mock-claude", "--max-attempts", "5"],
      {
        VIBE_MAX_ATTEMPTS: "1",
        VIBE_TEST_ANTHROPIC_MODE: "proceed",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(payload).toMatchObject({ proceed: true, attempts: 1 });
  });

  test("check emits exhausted block JSON and exits 2 at attempt boundary", async () => {
    const { result, payload } = await runVibeCheck(["--max-attempts", "1"], {
      VIBE_TEST_ANTHROPIC_MODE: "block",
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("");
    expect(payload).toMatchObject({
      proceed: false,
      exhausted: true,
      attempts: 1,
      reason: "block:claude-haiku-4-5-20251001",
    });
  });

  test("VIBE_MAX_ATTEMPTS non-numeric env var silently falls back to 10", async () => {
    const { result, payload } = await runVibeCheck(["--model", "mock-claude"], {
      VIBE_MAX_ATTEMPTS: "abc",
      VIBE_TEST_ANTHROPIC_MODE: "proceed",
    });

    expect(result.exitCode).toBe(0);
    expect(payload).toMatchObject({ proceed: true, attempts: 1 });
  });

  test("--max-attempts 0 flag falls back to 10 due to falsy default", async () => {
    const { result, payload } = await runVibeCheck(["--max-attempts", "0"], {
      VIBE_TEST_ANTHROPIC_MODE: "block",
    });

    expect(result.exitCode).toBe(2);
    expect(payload.exhausted).toBe(true);
    expect(payload.attempts).toBeGreaterThanOrEqual(1);
  });

  test("VIBE_MAX_ATTEMPTS=0 env var falls back to 10 due to falsy default", async () => {
    const { result, payload } = await runVibeCheck([], {
      VIBE_MAX_ATTEMPTS: "0",
      VIBE_TEST_ANTHROPIC_MODE: "block",
    });

    expect(result.exitCode).toBe(2);
    expect(payload.exhausted).toBe(true);
    expect(payload.attempts).toBeGreaterThanOrEqual(1);
  });

  test("verify emits JSON success and exits 0 with mocked Anthropic", async () => {
    const home = await useTempHome();

    const result = runCli(
      ["verify", "--provider", "anthropic", "--model", "mock-verify"],
      {
        home: home.home,
        preload: mockAnthropicFetch,
        env: { ANTHROPIC_API_KEY: "ak", DEFAULT_MODEL: undefined },
      },
    );
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      provider: string;
      model: string;
      response: string;
    };

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(payload).toMatchObject({
      ok: true,
      provider: "anthropic",
      model: "mock-verify",
    });
    expect(payload.response).toContain("questions:mock-verify");
  });

  test("learn command emits validation failure JSON without process failure", async () => {
    const home = await useTempHome();

    const result = runCli(
      ["learn", "--mistake", "Repeated risky plan.", "--category", "risk"],
      { home: home.home },
    );
    const payload = JSON.parse(result.stdout) as {
      added: boolean;
      alreadyKnown: boolean;
      currentTally: number;
      topCategories: unknown[];
    };

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      "--solution is required for mistake and success types",
    );
    expect(payload).toEqual({
      added: false,
      alreadyKnown: false,
      currentTally: 0,
      topCategories: [],
    });
  });

  test("constitution commands preserve ordered state and support clearing", async () => {
    const home = await useTempHome();
    const cwd = await createCwd();

    const set = runCli(
      ["constitution", "set", "--rule", "Prefer tests", "Prefer rollbacks"],
      { cwd, home: home.home },
    );
    const get = runCli(["constitution", "get"], { cwd, home: home.home });
    const reset = runCli(["constitution", "reset"], { cwd, home: home.home });

    expect(set.exitCode).toBe(0);
    expect(JSON.parse(set.stdout)).toMatchObject({
      rules: ["Prefer tests", "Prefer rollbacks"],
    });
    expect(JSON.parse(get.stdout)).toMatchObject({
      rules: ["Prefer tests", "Prefer rollbacks"],
    });
    expect(JSON.parse(reset.stdout)).toMatchObject({ rules: [] });
  });
});
