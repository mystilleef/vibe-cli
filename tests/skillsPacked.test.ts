import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ChildProcessResult, runChild } from "./helpers/childProcess.js";
import { packAndExtract } from "./helpers/packedPackage.js";
import { dirExists, fileExists } from "./helpers/skillsTestUtils.js";

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

/** Run the packed CLI and reject abnormal process states. */
async function runPackedCli(
  extractedRoot: string,
  args: string[],
  options: {
    home: string;
    cwd?: string;
    extraEnv?: Record<string, string>;
  },
): Promise<ChildProcessResult> {
  const cli = join(extractedRoot, "dist", "vibe.js");
  return runChild("bun", ["run", cli, ...args], {
    cwd: options.cwd ?? options.home,
    env: {
      ...process.env,
      HOME: options.home,
      CI: "true",
      NO_COLOR: "1",
      PAGER: "cat",
      TERM: "dumb",
      ...options.extraEnv,
    },
    timeout: 30_000,
  });
}

let extractedRoot: string;

/** Pack and extract once; the fixture is reused across tests. */
beforeAll(async () => {
  const fixture = await packAndExtract(".skills-pack-");
  packFixtureRoot = fixture.workRoot;
  extractedRoot = fixture.extractedRoot;
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
}, 90_000);

describe("packed package skills surface", () => {
  test("extracted package lists bundled skills and preserves dry-run target", async () => {
    const home = await createTempRoot(".skills-pack-home-");
    const target = join(home, "agents-skills");

    // Default output prints readable Skills section.
    const listPretty = await runPackedCli(
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
    const list = await runPackedCli(
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
    const dryPretty = await runPackedCli(
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
    const dryRun = await runPackedCli(
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
    const installPretty = await runPackedCli(
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
    const install = await runPackedCli(
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
    const blockedPretty = await runPackedCli(
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
    const blocked = await runPackedCli(
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

    const install = await runPackedCli(
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
    const forcedPretty = await runPackedCli(
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
    const forced = await runPackedCli(
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

    const schema = await runPackedCli(extractedRoot, ["schema"], { home });
    expect(schema.exitCode).toBe(0);
    expect(schema.stderr).toBe("");
    const payload = JSON.parse(schema.stdout) as {
      commands: Record<string, unknown>;
    };
    expect(payload.commands["skills list"]).toBeDefined();
    expect(payload.commands["skills install"]).toBeDefined();

    const help = await runPackedCli(
      extractedRoot,
      ["skills", "install", "--help"],
      {
        home,
      },
    );
    expect(help.exitCode).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toContain("--target");
    expect(help.stdout).toContain("--dry-run");
    expect(help.stdout).toContain("--force");
    expect(help.stdout).toContain("--json");

    const listHelp = await runPackedCli(
      extractedRoot,
      ["skills", "list", "--help"],
      {
        home,
      },
    );
    expect(listHelp.exitCode).toBe(0);
    expect(listHelp.stdout).toContain("--json");
  }, 60_000);

  test("extracted package keeps operational failures on stderr only", async () => {
    const home = await createTempRoot(".skills-pack-home-");
    const missingParent = join(home, "no-parent", "skills");

    const result = await runPackedCli(
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
