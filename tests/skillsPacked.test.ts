import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  normalizePackedChild,
  type PackedChildFailureKind,
  type PackedChildProcess,
  requirePackedChild,
} from "./helpers/packedChildResult.js";

const originalCwd = process.cwd();
const packageRoot = originalCwd;
const tempRoots: string[] = [];
/** Packed fixture root — owned by beforeAll/afterAll, not afterEach. */
let packFixtureRoot: string | undefined;

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(
    tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

afterAll(async () => {
  if (packFixtureRoot) {
    await rm(packFixtureRoot, { recursive: true, force: true });
    packFixtureRoot = undefined;
  }
});

async function createTempRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(packageRoot, prefix));
  tempRoots.push(dir);
  return dir;
}

async function dirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Deterministic child-process helper for packed CLI invocation.
 *
 * Uses Node `spawnSync` rather than `Bun.spawnSync` to avoid ~800ms per-call
 * overhead that accumulates across sequential invocations and causes test
 * timeouts. The packed CLI process lifecycle completes deterministically in
 * 150–1200ms through this path depending on operation complexity.
 */
function runPackedCli(
  extractedRoot: string,
  args: string[],
  options: {
    home: string;
    cwd?: string;
    extraEnv?: Record<string, string>;
  },
): PackedChildProcess {
  const cli = join(extractedRoot, "dist", "vibe.js");
  const env: Record<string, string> = {
    ...process.env,
    HOME: options.home,
    CI: "true",
    NO_COLOR: "1",
    PAGER: "cat",
    TERM: "dumb",
    ...options.extraEnv,
  };

  const result = spawnSync("bun", ["run", cli, ...args], {
    cwd: options.cwd ?? options.home,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    encoding: "utf-8",
  });

  // Abnormal process states (timeout, signal, spawn error, null status)
  // are rejected here — stdout and stderr are never parsed against
  // ambiguous completion.
  return requirePackedChild(result, args.join(" "));
}

async function packAndExtract(): Promise<string> {
  const workRoot = await mkdtemp(join(packageRoot, ".skills-pack-"));
  const packDir = join(workRoot, "pack");
  const extractDir = join(workRoot, "extract");
  await mkdir(packDir, { recursive: true });
  await mkdir(extractDir, { recursive: true });

  // Rebuild dist so the packed CLI matches current source contracts.
  const buildResult = spawnSync("bun", ["run", "build"], {
    cwd: packageRoot,
    env: {
      ...process.env,
      CI: "true",
      NO_COLOR: "1",
      PAGER: "cat",
      TERM: "dumb",
    },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    encoding: "utf-8",
  });
  expect(buildResult.status).toBe(0);

  const packResult = spawnSync(
    "bun",
    ["pm", "pack", "--destination", packDir, "--ignore-scripts", "--quiet"],
    {
      cwd: packageRoot,
      env: {
        ...process.env,
        CI: "true",
        NO_COLOR: "1",
        PAGER: "cat",
        TERM: "dumb",
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      encoding: "utf-8",
    },
  );
  expect(packResult.status).toBe(0);

  const packedFiles = (await readdir(packDir)).filter((name) =>
    name.endsWith(".tgz"),
  );
  expect(packedFiles).toHaveLength(1);
  const tarball = join(packDir, packedFiles[0] as string);

  const extractResult = spawnSync("tar", ["-xzf", tarball, "-C", extractDir], {
    cwd: packageRoot,
    env: process.env as Record<string, string>,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
    encoding: "utf-8",
  });
  expect(extractResult.status).toBe(0);

  const extractedRoot = join(extractDir, "package");
  expect(await fileExists(join(extractedRoot, "package.json"))).toBe(true);
  expect(await fileExists(join(extractedRoot, "dist", "vibe.js"))).toBe(true);
  expect(
    await fileExists(join(extractedRoot, "skills", "vibe-check", "SKILL.md")),
  ).toBe(true);
  expect(
    await fileExists(
      join(extractedRoot, "skills", "vibe-constitution", "SKILL.md"),
    ),
  ).toBe(true);
  expect(
    await fileExists(join(extractedRoot, "skills", "vibe-learn", "SKILL.md")),
  ).toBe(true);

  packFixtureRoot = workRoot;
  return extractedRoot;
}

let extractedRoot: string;

beforeAll(async () => {
  extractedRoot = await packAndExtract();
}, 90_000);

describe("packed package skills surface", () => {
  test("extracted package lists bundled skills and preserves dry-run target", async () => {
    const home = await createTempRoot(".skills-pack-home-");
    const target = join(home, "agents-skills");

    // Default output prints readable Skills section.
    const listPretty = runPackedCli(
      extractedRoot,
      ["skills", "list", "--target", target],
      { home },
    );
    expect(listPretty.exitCode).toBe(0);
    expect(listPretty.stderr).toBe("");
    expect(listPretty.stdout).toContain("Skills");
    expect(listPretty.stdout).toContain("vibe-check");
    expect(listPretty.stdout).toContain("missing");

    // --json preserves parseable payload.
    const list = runPackedCli(
      extractedRoot,
      ["skills", "list", "--json", "--target", target],
      { home },
    );
    expect(list.exitCode).toBe(0);
    expect(list.stderr).toBe("");
    expect(list.stdout.trim().split("\n")).toHaveLength(1);
    const listPayload = JSON.parse(list.stdout) as {
      target: string;
      skills: Array<{ name: string; status: string }>;
    };
    expect(listPayload.target).toBe(target);
    expect(listPayload.skills.map((s) => s.name)).toEqual([
      "vibe-check",
      "vibe-constitution",
      "vibe-learn",
    ]);
    expect(listPayload.skills.every((s) => s.status === "missing")).toBe(true);
    expect(await dirExists(target)).toBe(false);

    // Default output prints readable Skills Install section.
    const dryPretty = runPackedCli(
      extractedRoot,
      ["skills", "install", "--dry-run", "--target", target],
      { home },
    );
    expect(dryPretty.exitCode).toBe(0);
    expect(dryPretty.stderr).toBe("");
    expect(dryPretty.stdout).toContain("Skills Install");
    expect(dryPretty.stdout).toContain("dryRun: true");
    expect(dryPretty.stdout).toContain("would-install");
    expect(await dirExists(target)).toBe(false);

    // --json preserves parseable payload.
    const dryRun = runPackedCli(
      extractedRoot,
      ["skills", "install", "--dry-run", "--json", "--target", target],
      { home },
    );
    expect(dryRun.exitCode).toBe(0);
    expect(dryRun.stderr).toBe("");
    const dryPayload = JSON.parse(dryRun.stdout) as {
      dryRun: boolean;
      ok: boolean;
      skills: Array<{ action: string }>;
    };
    expect(dryPayload.dryRun).toBe(true);
    expect(dryPayload.ok).toBe(true);
    expect(dryPayload.skills.every((s) => s.action === "would-install")).toBe(
      true,
    );
    expect(await dirExists(target)).toBe(false);
  }, 60_000);

  test("extracted package installs bundled skills and blocks modified targets", async () => {
    const home = await createTempRoot(".skills-pack-home-");
    const target = join(home, "agents-skills");

    // Default output prints readable Skills Install section.
    const installPretty = runPackedCli(
      extractedRoot,
      ["skills", "install", "--target", target],
      { home },
    );
    expect(installPretty.exitCode).toBe(0);
    expect(installPretty.stderr).toBe("");
    expect(installPretty.stdout).toContain("Skills Install");
    expect(installPretty.stdout).toContain("installed");
    expect(await fileExists(join(target, "vibe-check", "SKILL.md"))).toBe(true);
    expect(
      await fileExists(join(target, "vibe-constitution", "SKILL.md")),
    ).toBe(true);
    expect(await fileExists(join(target, "vibe-learn", "SKILL.md"))).toBe(true);

    // --json preserves parseable payload.
    const install = runPackedCli(
      extractedRoot,
      ["skills", "install", "--json", "--target", target],
      { home },
    );
    expect(install.exitCode).toBe(0);
    expect(install.stderr).toBe("");
    const installPayload = JSON.parse(install.stdout) as {
      ok: boolean;
      skills: Array<{ action: string }>;
    };
    expect(installPayload.ok).toBe(true);
    // Second install is idempotent — skills are unchanged.
    expect(installPayload.skills.every((s) => s.action === "unchanged")).toBe(
      true,
    );

    await writeFile(
      join(target, "vibe-learn", "SKILL.md"),
      "packed-layout local edit\n",
    );

    // Default blocked output prints readable section with error detail.
    const blockedPretty = runPackedCli(
      extractedRoot,
      ["skills", "install", "--target", target],
      { home },
    );
    expect(blockedPretty.exitCode).toBe(2);
    expect(blockedPretty.stderr).toBe("");
    expect(blockedPretty.stdout).toContain("Skills Install");
    expect(blockedPretty.stdout).toContain("blocked");
    expect(blockedPretty.stdout).toContain("vibe-learn");

    // --json preserves parseable payload with blocked action.
    const blocked = runPackedCli(
      extractedRoot,
      ["skills", "install", "--json", "--target", target],
      { home },
    );
    expect(blocked.exitCode).toBe(2);
    expect(blocked.stderr).toBe("");
    const blockedPayload = JSON.parse(blocked.stdout) as {
      ok: boolean;
      skills: Array<{ name: string; action: string }>;
    };
    expect(blockedPayload.ok).toBe(false);
    expect(
      blockedPayload.skills.find((s) => s.name === "vibe-learn")?.action,
    ).toBe("blocked");
    expect(await readFile(join(target, "vibe-learn", "SKILL.md"), "utf8")).toBe(
      "packed-layout local edit\n",
    );
  }, 60_000);

  test("extracted package force-replaces modified and up-to-date bundled skills deterministically", async () => {
    // First install normally, then modify one skill to exercise both modified
    // and up-to-date replacement paths in a single force install.
    const home = await createTempRoot(".skills-pack-home-");
    const target = join(home, "agents-skills");

    const install = runPackedCli(
      extractedRoot,
      ["skills", "install", "--json", "--target", target],
      { home },
    );
    expect(install.exitCode).toBe(0);

    // Modify one skill; the other two remain up-to-date.
    await writeFile(
      join(target, "vibe-learn", "SKILL.md"),
      "packed-layout local edit\n",
    );

    // Default output prints readable Skills Install section.
    const forcedPretty = runPackedCli(
      extractedRoot,
      ["skills", "install", "--force", "--target", target],
      { home },
    );
    expect(forcedPretty.exitCode).toBe(0);
    expect(forcedPretty.stderr).toBe("");
    expect(forcedPretty.stdout).toContain("Skills Install");
    expect(forcedPretty.stdout).toContain("force: true");
    expect(forcedPretty.stdout).toContain("replaced");

    // --json preserves parseable payload.
    const forced = runPackedCli(
      extractedRoot,
      ["skills", "install", "--force", "--json", "--target", target],
      { home },
    );
    expect(forced.exitCode).toBe(0);
    expect(forced.stderr).toBe("");
    const forcedPayload = JSON.parse(forced.stdout) as {
      ok: boolean;
      force: boolean;
      skills: Array<{ name: string; action: string }>;
    };
    expect(forcedPayload.ok).toBe(true);
    expect(forcedPayload.force).toBe(true);
    // Both modified and up-to-date skills get replaced under --force.
    const skillActions = forcedPayload.skills.map((s) => ({
      name: s.name,
      action: s.action,
    }));
    expect(skillActions).toEqual([
      { name: "vibe-check", action: "replaced" },
      { name: "vibe-constitution", action: "replaced" },
      { name: "vibe-learn", action: "replaced" },
    ]);

    // Payload assertions: replaced files match source byte-for-byte.
    const sourceLearn = await readFile(
      join(extractedRoot, "skills", "vibe-learn", "SKILL.md"),
      "utf8",
    );
    expect(await readFile(join(target, "vibe-learn", "SKILL.md"), "utf8")).toBe(
      sourceLearn,
    );
    const sourceCheck = await readFile(
      join(extractedRoot, "skills", "vibe-check", "SKILL.md"),
      "utf8",
    );
    expect(await readFile(join(target, "vibe-check", "SKILL.md"), "utf8")).toBe(
      sourceCheck,
    );
    const sourceConstitution = await readFile(
      join(extractedRoot, "skills", "vibe-constitution", "SKILL.md"),
      "utf8",
    );
    expect(
      await readFile(join(target, "vibe-constitution", "SKILL.md"), "utf8"),
    ).toBe(sourceConstitution);
  }, 60_000);

  test("extracted package reports schema skills contracts and help text", async () => {
    const home = await createTempRoot(".skills-pack-home-");

    const schema = runPackedCli(extractedRoot, ["schema"], { home });
    expect(schema.exitCode).toBe(0);
    expect(schema.stderr).toBe("");
    const payload = JSON.parse(schema.stdout) as {
      commands: Record<string, unknown>;
    };
    expect(payload.commands["skills list"]).toBeDefined();
    expect(payload.commands["skills install"]).toBeDefined();

    const help = runPackedCli(extractedRoot, ["skills", "install", "--help"], {
      home,
    });
    expect(help.exitCode).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toContain("--target");
    expect(help.stdout).toContain("--dry-run");
    expect(help.stdout).toContain("--force");
    expect(help.stdout).toContain("--json");

    const listHelp = runPackedCli(extractedRoot, ["skills", "list", "--help"], {
      home,
    });
    expect(listHelp.exitCode).toBe(0);
    expect(listHelp.stdout).toContain("--json");
  }, 60_000);

  test("extracted package keeps operational failures on stderr only", async () => {
    const home = await createTempRoot(".skills-pack-home-");
    const missingParent = join(home, "no-parent", "skills");

    const result = runPackedCli(
      extractedRoot,
      ["skills", "install", "--target", missingParent],
      { home },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    const payload = JSON.parse(result.stderr) as { error: string };
    expect(payload.error).toContain("Target parent");
  }, 60_000);
});

describe("packed child-result validation", () => {
  const JSON_STDOUT = '{"ok":true}\n';

  function fakeChildResult(
    overrides: Partial<SpawnSyncReturns<string>>,
  ): SpawnSyncReturns<string> {
    return {
      pid: 1234,
      output: [null, "", ""],
      stdout: "",
      stderr: "",
      status: 0,
      signal: null,
      ...overrides,
    } as SpawnSyncReturns<string>;
  }

  // Deterministic synthetic results — process-state validation without
  // relying on platform timing. Abnormal cases carry valid-looking JSON
  // stdout to prove output assertions are blocked by the guard.
  const abnormalCases: Array<{
    name: string;
    result: SpawnSyncReturns<string>;
    kind: PackedChildFailureKind;
  }> = [
    {
      name: "timeout",
      result: fakeChildResult({
        error: Object.assign(new Error("spawnSync bun ETIMEDOUT"), {
          code: "ETIMEDOUT",
        }),
        status: null,
        signal: "SIGTERM",
        stdout: JSON_STDOUT,
      }),
      kind: "timeout",
    },
    {
      name: "spawn error",
      result: fakeChildResult({
        error: Object.assign(new Error("spawnSync bun ENOENT"), {
          code: "ENOENT",
        }),
        status: null,
        signal: null,
        stdout: JSON_STDOUT,
      }),
      kind: "spawn-error",
    },
    {
      name: "signal termination",
      result: fakeChildResult({
        status: null,
        signal: "SIGKILL",
        stdout: JSON_STDOUT,
      }),
      kind: "signal",
    },
    {
      name: "null status",
      result: fakeChildResult({
        status: null,
        signal: null,
        stdout: JSON_STDOUT,
      }),
      kind: "null-status",
    },
  ];

  for (const { name, result, kind } of abnormalCases) {
    test(`rejects ${name} before stdout or stderr parsing`, () => {
      const normalized = normalizePackedChild(result);
      expect(normalized.ok).toBe(false);
      if (!normalized.ok) {
        expect(normalized.failure.kind).toBe(kind);
        expect(normalized.failure.detail.length).toBeGreaterThan(0);
      }
      expect(() => requirePackedChild(result, "synthetic")).toThrow(
        new RegExp(kind),
      );
    });
  }

  test("accepts a successful child result for JSON assertions", () => {
    const result = fakeChildResult({
      status: 0,
      stdout: JSON_STDOUT,
      stderr: "",
    });
    const normalized = normalizePackedChild(result);
    expect(normalized.ok).toBe(true);
    const child = requirePackedChild(result, "synthetic");
    expect(child.exitCode).toBe(0);
    expect(child.stderr).toBe("");
    expect((JSON.parse(child.stdout) as { ok: boolean }).ok).toBe(true);
  });

  test("accepts an expected command failure with a concrete nonzero code", () => {
    const stderrPayload = '{"error":"expected failure"}\n';
    const result = fakeChildResult({
      status: 2,
      stdout: "",
      stderr: stderrPayload,
    });
    const normalized = normalizePackedChild(result);
    expect(normalized.ok).toBe(true);
    const child = requirePackedChild(result, "synthetic");
    expect(child.exitCode).toBe(2);
    expect((JSON.parse(child.stderr) as { error: string }).error).toBe(
      "expected failure",
    );
  });
});
