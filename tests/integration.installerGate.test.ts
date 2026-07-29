/**
 * Integration coverage for the plain-copy skill installer: exercises
 * installSkills() end-to-end against a real filesystem (both fabricated
 * fixtures and the project's real bundled skills/), plus one CLI-level
 * exit-code check. See proposals/simplify-skill-installation.md.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { runCliInProcess } from "../src/cli";
import {
  InstallError,
  type InstallResult,
  installSkills,
} from "../src/tools/skillsInstaller.js";
import {
  createPackageRoot,
  createSkillDir,
  createTempDir,
  dirExists,
  fileExists,
  readDirTree,
} from "./helpers/skillsTestUtils.js";

let tempDirs: string[] = [];
let originalCwd: string;

beforeEach(() => {
  tempDirs = [];
  originalCwd = process.cwd();
});

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(
    tempDirs.map(async (dir) => {
      try {
        await chmodRecursiveWritable(dir);
      } catch {
        // best effort before rm
      }
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup races
      }
    }),
  );
});

async function chmodRecursiveWritable(dir: string): Promise<void> {
  try {
    await chmod(dir, 0o755);
  } catch {
    return;
  }
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    try {
      const s = await stat(full);
      if (s.isDirectory()) {
        await chmodRecursiveWritable(full);
      } else {
        await chmod(full, 0o644);
      }
    } catch {
      // ignore
    }
  }
}

function actionMap(result: InstallResult): Record<string, string> {
  return Object.fromEntries(result.skills.map((s) => [s.name, s.action]));
}

const REAL_SKILL_NAMES = ["vibe-check", "vibe-constitution", "vibe-learn"];

describe("Integration - real bundled skills", () => {
  test("installs the real bundled skill set end-to-end", async () => {
    const targetRoot = await createTempDir(tempDirs);

    const result = await installSkills(targetRoot, {
      dryRun: false,
      force: false,
    });

    expect(result.ok).toBe(true);
    expect(result.skills.map((s) => s.name)).toEqual(REAL_SKILL_NAMES);
    expect(result.skills.every((s) => s.action === "installed")).toBe(true);
    for (const name of REAL_SKILL_NAMES) {
      expect(await fileExists(join(targetRoot, name, "SKILL.md"))).toBe(true);
    }
  });

  test("dry-run against the real bundle reports would-install without writes", async () => {
    const targetRoot = join(await createTempDir(tempDirs), "skills");

    const result = await installSkills(targetRoot, {
      dryRun: true,
      force: false,
    });

    expect(result.ok).toBe(true);
    expect(result.skills.every((s) => s.action === "would-install")).toBe(true);
    expect(await dirExists(targetRoot)).toBe(false);
  });

  test("force replaces a locally modified real skill with source content", async () => {
    const targetRoot = await createTempDir(tempDirs);
    await installSkills(targetRoot, { dryRun: false, force: false });
    await writeFile(
      join(targetRoot, "vibe-check", "SKILL.md"),
      "locally modified\n",
    );

    const result = await installSkills(targetRoot, {
      dryRun: false,
      force: true,
    });

    expect(result.ok).toBe(true);
    expect(actionMap(result)["vibe-check"]).toBe("replaced");
    expect(
      await readFile(join(targetRoot, "vibe-check", "SKILL.md"), "utf8"),
    ).not.toBe("locally modified\n");
  });
});

describe("Integration - missing package root", () => {
  test("surfaces a missing skills directory as a fatal source error", async () => {
    const packageRoot = await createTempDir(tempDirs);
    await writeFile(join(packageRoot, "package.json"), "{}\n");
    const targetRoot = join(await createTempDir(tempDirs), "skills");

    await expect(
      installSkills(targetRoot, { dryRun: false, force: false, packageRoot }),
    ).rejects.toThrow(InstallError);
    await expect(
      installSkills(targetRoot, { dryRun: false, force: false, packageRoot }),
    ).rejects.toThrow(/Skills directory does not exist/);
    expect(await dirExists(targetRoot)).toBe(false);
  });

  test("empty skills directory yields an empty successful plan without creating the target", async () => {
    const packageRoot = await createPackageRoot(tempDirs);
    const targetRoot = join(await createTempDir(tempDirs), "skills");

    const result = await installSkills(targetRoot, {
      dryRun: false,
      force: false,
      packageRoot,
    });

    expect(result).toMatchObject({ ok: true, skills: [] });
    expect(await dirExists(targetRoot)).toBe(false);
  });
});

describe("Integration - permission errors", () => {
  test("permission-denied target parent fails before any writes", async () => {
    if (process.getuid?.() === 0) {
      return;
    }
    const packageRoot = await createPackageRoot(tempDirs, {
      "skill-a": { "SKILL.md": "# A" },
    });
    const parent = await createTempDir(tempDirs);
    const targetRoot = join(parent, "skills");
    await chmod(parent, 0o555);

    try {
      await expect(
        installSkills(targetRoot, {
          dryRun: false,
          force: false,
          packageRoot,
        }),
      ).rejects.toThrow(/No write access/);
      expect(await dirExists(targetRoot)).toBe(false);
    } finally {
      await chmod(parent, 0o755);
    }
  });

  test("permission-denied copy destination fails the affected skill only", async () => {
    if (process.getuid?.() === 0) {
      return;
    }
    const packageRoot = await createPackageRoot(tempDirs, {
      "skill-a": { "SKILL.md": "# A" },
      "skill-b": { "SKILL.md": "# B" },
    });
    const targetRoot = await createTempDir(tempDirs);
    await chmod(targetRoot, 0o555);

    try {
      const result = await installSkills(targetRoot, {
        dryRun: false,
        force: false,
        packageRoot,
      });

      expect(result.ok).toBe(false);
      for (const skill of result.skills) {
        expect(skill.action).toBe("failed");
        expect(skill.error).toMatch(/EACCES/);
      }
    } finally {
      await chmod(targetRoot, 0o755);
    }
  });
});

describe("Integration - partial-failure exit semantics", () => {
  test("one skill failing to copy does not block independent skills", async () => {
    if (process.getuid?.() === 0) {
      return;
    }
    const packageRoot = await createPackageRoot(tempDirs, {
      "skill-a": { "SKILL.md": "# A" },
      "skill-b": { "SKILL.md": "# B" },
    });
    const targetRoot = await createTempDir(tempDirs);
    // skill-b is pre-installed and locked read-only, so its --force
    // replace fails at copy time while skill-a (fresh, missing) succeeds.
    await createSkillDir(targetRoot, "skill-b", { "SKILL.md": "# B" });
    await chmod(join(targetRoot, "skill-b", "SKILL.md"), 0o444);
    await chmod(join(targetRoot, "skill-b"), 0o555);

    try {
      const result = await installSkills(targetRoot, {
        dryRun: false,
        force: true,
        packageRoot,
      });

      expect(result.ok).toBe(false);
      const byName = actionMap(result);
      expect(byName["skill-a"]).toBe("installed");
      expect(byName["skill-b"]).toBe("failed");
      expect(await readDirTree(join(targetRoot, "skill-a"))).toEqual({
        "SKILL.md": "# A",
      });
    } finally {
      await chmod(join(targetRoot, "skill-b"), 0o755);
      await chmod(join(targetRoot, "skill-b", "SKILL.md"), 0o644);
    }
  });

  test("partial copy failure surfaces ok:false and exit code 2 through the CLI", async () => {
    if (process.getuid?.() === 0) {
      return;
    }
    const targetRoot = await createTempDir(tempDirs);
    const initial = await runCliInProcess([
      "skills",
      "install",
      "--target",
      targetRoot,
    ]);
    expect(initial.exitCode).toBe(0);

    const lockedSkillDir = join(targetRoot, "vibe-learn");
    await chmod(join(lockedSkillDir, "SKILL.md"), 0o444);
    await chmod(lockedSkillDir, 0o555);

    try {
      const result = await runCliInProcess([
        "skills",
        "install",
        "--force",
        "--target",
        targetRoot,
      ]);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe("");
      const payload = JSON.parse(result.stdout) as InstallResult;
      expect(payload.ok).toBe(false);
      expect(payload.skills.find((s) => s.name === "vibe-learn")?.action).toBe(
        "failed",
      );
      expect(payload.skills.find((s) => s.name === "vibe-check")?.action).toBe(
        "replaced",
      );
    } finally {
      await chmod(lockedSkillDir, 0o755);
      await chmod(join(lockedSkillDir, "SKILL.md"), 0o644);
    }
  });
});

describe("Integration - modified-without-force gate", () => {
  test("blocks the whole batch and creates nothing for a fresh target", async () => {
    const packageRoot = await createPackageRoot(tempDirs, {
      alpha: { "SKILL.md": "# A", "file.txt": "src" },
      beta: { "SKILL.md": "# B" },
    });
    const targetRoot = await createTempDir(tempDirs);
    await createSkillDir(targetRoot, "alpha", {
      "SKILL.md": "# A",
      "file.txt": "modified",
    });

    const result = await installSkills(targetRoot, {
      dryRun: false,
      force: false,
      packageRoot,
    });

    expect(result.ok).toBe(false);
    // "beta" reports its planned action even though the batch never ran.
    expect(actionMap(result)).toEqual({ alpha: "blocked", beta: "installed" });
    expect(await dirExists(join(targetRoot, "beta"))).toBe(false);
    expect(await readFile(join(targetRoot, "alpha", "file.txt"), "utf8")).toBe(
      "modified",
    );
  });
});
