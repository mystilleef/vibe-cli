import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCliInProcess } from "../src/cli";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome";

let tempHome: TempHomeContext;
let originalCwd: string;
const tempDirs: string[] = [];

beforeEach(async () => {
  tempHome = await createTempHome();
  originalCwd = process.cwd();
});

afterEach(async () => {
  process.chdir(originalCwd);
  await tempHome.cleanup();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function runCli(
  args: string[],
  options: { home?: string; cwd?: string } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const savedCwd = process.cwd();
  process.chdir(options.cwd ?? originalCwd);
  const savedHome = process.env["HOME"];
  process.env["HOME"] = options.home ?? tempHome.home;
  try {
    return await runCliInProcess(args);
  } finally {
    process.env["HOME"] = savedHome;
    process.chdir(savedCwd);
  }
}

describe("settings install CLI surface", () => {
  test("help output shows expected options", async () => {
    const result = await runCli(["settings", "install", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("--dry-run");
    expect(result.stdout).toContain("--force");
    expect(result.stdout).toContain("--json");
  });

  test("settings group exposes only install subcommand", async () => {
    const result = await runCli(["settings", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("install");
  });

  test("successful install exits 0 with required result payload", async () => {
    const result = await runCli(["settings", "install", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    const payload = JSON.parse(result.stdout) as {
      destination: string;
      dryRun: boolean;
      force: boolean;
      ok: boolean;
      status: string;
      action: string;
    };
    expect(payload).toMatchObject({
      destination: join(tempHome.home, ".vibe-cli", "settings.json"),
      dryRun: false,
      force: false,
      ok: true,
      status: "missing",
      action: "installed",
    });
  });

  test("successful skip exits 0 with skip payload", async () => {
    // First install to create the file
    await runCli(["settings", "install", "--json"]);

    // Second install should skip
    const result = await runCli(["settings", "install", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as {
      status: string;
      action: string;
    };
    expect(payload).toMatchObject({
      status: "present",
      action: "skipped",
    });
  });

  test("dry-run exits 0 with would-install for missing destination", async () => {
    const result = await runCli(["settings", "install", "--dry-run", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as {
      dryRun: boolean;
      status: string;
      action: string;
    };
    expect(payload).toMatchObject({
      dryRun: true,
      status: "missing",
      action: "would-install",
    });
  });

  test("dry-run exits 0 with would-skip for present destination", async () => {
    await runCli(["settings", "install", "--json"]);
    const result = await runCli(["settings", "install", "--dry-run", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as {
      dryRun: boolean;
      status: string;
      action: string;
    };
    expect(payload).toMatchObject({
      dryRun: true,
      status: "present",
      action: "would-skip",
    });
  });

  test("force exits 0 with replaced for present destination", async () => {
    await runCli(["settings", "install", "--json"]);
    const result = await runCli(["settings", "install", "--force", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as {
      force: boolean;
      status: string;
      action: string;
    };
    expect(payload).toMatchObject({
      force: true,
      status: "present",
      action: "replaced",
    });
  });

  test("force with dry-run exits 0 with would-replace for present destination", async () => {
    await runCli(["settings", "install", "--json"]);
    const result = await runCli([
      "settings",
      "install",
      "--force",
      "--dry-run",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as {
      dryRun: boolean;
      force: boolean;
      status: string;
      action: string;
    };
    expect(payload).toMatchObject({
      dryRun: true,
      force: true,
      status: "present",
      action: "would-replace",
    });
  });

  test("JSON stdout contains one payload only", async () => {
    const result = await runCli(["settings", "install", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    const firstLine = lines[0];
    expect(firstLine).toBeDefined();
    expect(() => JSON.parse(firstLine ?? "")).not.toThrow();
  });

  test("text output aligns summary fields", async () => {
    const result = await runCli(["settings", "install"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Settings Install");
    const labelLines = result.stdout
      .split("\n")
      .filter((line) =>
        /^(destination|dryRun|force|ok|status|action)\s*:/.test(line),
      );
    expect(labelLines).toHaveLength(6);
    expect(labelLines[0]).toContain("destination");
    const valueColumns = labelLines.map((line) => line.indexOf(":"));
    expect(new Set(valueColumns).size).toBe(1);
  });

  test("text output appends provider-key guidance only for actual installs", async () => {
    const installResult = await runCli(["settings", "install"]);
    expect(installResult.stdout).toContain("provider API key");

    const skipResult = await runCli(["settings", "install"]);
    expect(skipResult.stdout).not.toContain("provider API key");
  });

  test("text output appends provider-key guidance for replacements", async () => {
    await runCli(["settings", "install"]);
    const replaceResult = await runCli(["settings", "install", "--force"]);
    expect(replaceResult.stdout).toContain("provider API key");
  });

  test("JSON output suppresses provider-key guidance", async () => {
    const result = await runCli(["settings", "install", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("provider API key");
    expect(result.stdout).not.toContain("Configure");
  });

  test("unsupported options exit 1 with stderr-only fatal JSON", async () => {
    const result = await runCli(["settings", "install", "--bogus"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stderr)).toEqual({
      error: "error: unknown option '--bogus'",
    });
  });

  test("unknown settings subcommand fails", async () => {
    const result = await runCli(["settings", "unknown"]);

    expect(result.exitCode).not.toBe(0);
  });

  test('HOME="" installs to the same cwd-relative root loadProviderSettings reads', async () => {
    // HOME="" (explicitly empty, not unset) previously made the `~` target
    // resolver throw while getDataRoot() silently fell back to a
    // cwd-relative path — install and load disagreed on the destination.
    const cwd = await mkdtemp(join(tmpdir(), "vibe-cli-emptyhome-"));
    tempDirs.push(cwd);

    const result = await runCli(["settings", "install", "--json"], {
      home: "",
      cwd,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as {
      destination: string;
      ok: boolean;
    };
    expect(payload.ok).toBe(true);
    expect(payload.destination).toBe(join(cwd, ".vibe-cli", "settings.json"));
  });
});
