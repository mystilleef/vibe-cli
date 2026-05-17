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
  options: { cwd?: string; home?: string } = {},
): CliResult {
  const result = Bun.spawnSync({
    cmd: ["bun", "run", cli, ...args],
    cwd: options.cwd ?? originalCwd,
    env: { ...process.env, HOME: options.home ?? process.env.HOME ?? "" },
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

describe("CLI autosession surface", () => {
  test("affected help output omits public --session options", () => {
    expectHelpWithoutSession(["check"]);
    expectHelpWithoutSession(["learn"]);
    expectHelpWithoutSession(["constitution", "set"]);
    expectHelpWithoutSession(["constitution", "get"]);
    expectHelpWithoutSession(["constitution", "reset"]);

    const demoHelp = runCli(["demo", "--help"]);
    expect(demoHelp.stdout).toContain("--session");
  });

  test("removed --session options fail through Commander", () => {
    for (const command of [
      ["check", "--session", "x", "--goal", "g", "--plan", "p"],
      ["learn", "--session", "x", "--mistake", "m", "--category", "c"],
      ["constitution", "set", "--session", "x", "--rule", "r"],
      ["constitution", "get", "--session", "x"],
      ["constitution", "reset", "--session", "x"],
    ]) {
      const result = runCli(command);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("unknown option '--session'");
    }
  });

  test("session command emits JSON and refreshes lastAccessedAt", async () => {
    const home = await useTempHome();
    const cwd = await createCwd();
    const file = join(home.dataRoot, "sessions", `${getCwdKey(cwd)}.json`);

    const first = runCli(["session"], { cwd, home: home.home });
    const firstJson = JSON.parse(first.stdout) as { session: string };
    const oldTimestamp = new Date(Date.now() - 1000).toISOString();
    const record = JSON.parse(await readFile(file, "utf8"));
    await mkdir(join(home.dataRoot, "sessions"), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({ ...record, lastAccessedAt: oldTimestamp }),
    );

    const second = runCli(["session"], { cwd, home: home.home });
    const secondJson = JSON.parse(second.stdout) as { session: string };
    const touched = JSON.parse(await readFile(file, "utf8"));

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(firstJson.session).toMatch(/^[0-9a-f-]{36}$/);
    expect(secondJson.session).toBe(firstJson.session);
    expect(Date.parse(touched.lastAccessedAt)).toBeGreaterThan(
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
});
