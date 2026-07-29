import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  chmod,
  mkdir,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  InstallError,
  type InstallResult,
  InstallValidationError,
  installSkills,
} from "../src/tools/skillsInstaller.js";
import {
  createPackageRoot,
  createSkillDir,
  createTempDir,
  dirExists,
  readDirTree,
} from "./helpers/skillsTestUtils.js";

let tempDirs: string[] = [];
let originalCwd: string;

beforeEach(async () => {
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
        // ignore cleanup races (e.g. dangling symlinks)
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

describe("installSkills - planning and mixed inventory", () => {
  test("installs missing skills and preserves matching targets", async () => {
    const packageRoot = await createPackageRoot(tempDirs, {
      "skill-a": { "SKILL.md": "# A", "file.txt": "a" },
      "skill-b": { "SKILL.md": "# B", "file.txt": "b" },
    });
    const targetRoot = await createTempDir(tempDirs);
    await createSkillDir(targetRoot, "skill-b", {
      "SKILL.md": "# B",
      "file.txt": "b",
    });

    const result = await installSkills(targetRoot, {
      dryRun: false,
      force: false,
      packageRoot,
    });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.force).toBe(false);
    expect(result.target).toBe(targetRoot);
    expect(actionMap(result)).toEqual({
      "skill-a": "installed",
      "skill-b": "unchanged",
    });
    expect(await readDirTree(join(targetRoot, "skill-a"))).toEqual({
      "SKILL.md": "# A",
      "file.txt": "a",
    });
    expect(await readDirTree(join(targetRoot, "skill-b"))).toEqual({
      "SKILL.md": "# B",
      "file.txt": "b",
    });
  });

  test("blocks entire request when any modified target lacks force", async () => {
    const packageRoot = await createPackageRoot(tempDirs, {
      alpha: { "SKILL.md": "# A", "file.txt": "src" },
      beta: { "SKILL.md": "# B" },
      gamma: { "SKILL.md": "# G" },
    });
    const targetRoot = await createTempDir(tempDirs);
    await createSkillDir(targetRoot, "alpha", {
      "SKILL.md": "# A",
      "file.txt": "modified",
    });
    await createSkillDir(targetRoot, "beta", { "SKILL.md": "# B" });

    const before = await readDirTree(targetRoot);
    const result = await installSkills(targetRoot, {
      dryRun: false,
      force: false,
      packageRoot,
    });

    expect(result.ok).toBe(false);
    expect(actionMap(result)).toEqual({
      alpha: "blocked",
      beta: "unchanged",
      gamma: "installed",
    });
    // No mutation: gamma still missing, alpha still modified content
    expect(await dirExists(join(targetRoot, "gamma"))).toBe(false);
    expect(await readDirTree(targetRoot)).toEqual(before);
  });

  test("returns planned actions in lexical skill-name order", async () => {
    const packageRoot = await createPackageRoot(tempDirs, {
      zebra: { "SKILL.md": "# Z" },
      alpha: { "SKILL.md": "# A" },
      beta: { "SKILL.md": "# B" },
    });
    const targetRoot = await createTempDir(tempDirs);

    const result = await installSkills(targetRoot, {
      dryRun: true,
      force: false,
      packageRoot,
    });

    expect(result.skills.map((s) => s.name)).toEqual([
      "alpha",
      "beta",
      "zebra",
    ]);
  });

  test("idempotent match leaves targets unchanged without force", async () => {
    const packageRoot = await createPackageRoot(tempDirs, {
      "skill-a": { "SKILL.md": "# A", "nested/x.txt": "x" },
    });
    const targetRoot = await createTempDir(tempDirs);
    await createSkillDir(targetRoot, "skill-a", {
      "SKILL.md": "# A",
      "nested/x.txt": "x",
    });
    const before = await readDirTree(join(targetRoot, "skill-a"));

    const result = await installSkills(targetRoot, {
      dryRun: false,
      force: false,
      packageRoot,
    });

    expect(result.ok).toBe(true);
    expect(actionMap(result)).toEqual({ "skill-a": "unchanged" });
    expect(await readDirTree(join(targetRoot, "skill-a"))).toEqual(before);
  });
});

describe("installSkills - force mode", () => {
  test("force replaces every existing bundled target including hash matches", async () => {
    const packageRoot = await createPackageRoot(tempDirs, {
      match: { "SKILL.md": "# M", "file.txt": "same" },
      modified: { "SKILL.md": "# D", "file.txt": "new" },
      missing: { "SKILL.md": "# S" },
    });
    const targetRoot = await createTempDir(tempDirs);
    await createSkillDir(targetRoot, "match", {
      "SKILL.md": "# M",
      "file.txt": "same",
    });
    await createSkillDir(targetRoot, "modified", {
      "SKILL.md": "# D",
      "file.txt": "old",
    });

    const result = await installSkills(targetRoot, {
      dryRun: false,
      force: true,
      packageRoot,
    });

    expect(result.ok).toBe(true);
    expect(actionMap(result)).toEqual({
      match: "replaced",
      missing: "installed",
      modified: "replaced",
    });
    expect(await readDirTree(join(targetRoot, "match"))).toEqual({
      "SKILL.md": "# M",
      "file.txt": "same",
    });
    expect(await readDirTree(join(targetRoot, "modified"))).toEqual({
      "SKILL.md": "# D",
      "file.txt": "new",
    });
    expect(await readDirTree(join(targetRoot, "missing"))).toEqual({
      "SKILL.md": "# S",
    });
  });

  test("force replace removes target-only files the bundle no longer ships", async () => {
    const packageRoot = await createPackageRoot(tempDirs, {
      modified: { "SKILL.md": "# D" },
    });
    const targetRoot = await createTempDir(tempDirs);
    await createSkillDir(targetRoot, "modified", {
      "SKILL.md": "# D",
      "stale.txt": "orphaned",
    });

    const result = await installSkills(targetRoot, {
      dryRun: false,
      force: true,
      packageRoot,
    });

    expect(result.ok).toBe(true);
    expect(actionMap(result)).toEqual({ modified: "replaced" });
    expect(await readDirTree(join(targetRoot, "modified"))).toEqual({
      "SKILL.md": "# D",
    });
  });

  test("force dry-run plans would-replace without writing", async () => {
    const packageRoot = await createPackageRoot(tempDirs, {
      match: { "SKILL.md": "# M" },
      modified: { "SKILL.md": "# D", "file.txt": "new" },
      missing: { "SKILL.md": "# S" },
    });
    const targetRoot = await createTempDir(tempDirs);
    await createSkillDir(targetRoot, "match", { "SKILL.md": "# M" });
    await createSkillDir(targetRoot, "modified", {
      "SKILL.md": "# D",
      "file.txt": "old",
    });
    const before = await readDirTree(targetRoot);

    const result = await installSkills(targetRoot, {
      dryRun: true,
      force: true,
      packageRoot,
    });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(actionMap(result)).toEqual({
      match: "would-replace",
      missing: "would-install",
      modified: "would-replace",
    });
    expect(await readDirTree(targetRoot)).toEqual(before);
    expect(await dirExists(join(targetRoot, "missing"))).toBe(false);
  });
});

describe("installSkills - dry-run", () => {
  test("dry-run plans would-install for missing skills without writes", async () => {
    const packageRoot = await createPackageRoot(tempDirs, {
      "skill-a": { "SKILL.md": "# A" },
    });
    const targetRoot = await createTempDir(tempDirs);

    const result = await installSkills(targetRoot, {
      dryRun: true,
      force: false,
      packageRoot,
    });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(actionMap(result)).toEqual({ "skill-a": "would-install" });
    expect(await dirExists(join(targetRoot, "skill-a"))).toBe(false);
  });

  test("dry-run reports blocked for modified without force and writes nothing", async () => {
    const packageRoot = await createPackageRoot(tempDirs, {
      "skill-a": { "SKILL.md": "# A", "file.txt": "src" },
    });
    const targetRoot = await createTempDir(tempDirs);
    await createSkillDir(targetRoot, "skill-a", {
      "SKILL.md": "# A",
      "file.txt": "tgt",
    });
    const before = await readDirTree(targetRoot);

    const result = await installSkills(targetRoot, {
      dryRun: true,
      force: false,
      packageRoot,
    });

    expect(result.ok).toBe(false);
    expect(actionMap(result)).toEqual({ "skill-a": "blocked" });
    expect(await readDirTree(targetRoot)).toEqual(before);
  });

  test("dry-run reports unchanged for matching targets", async () => {
    const packageRoot = await createPackageRoot(tempDirs, {
      "skill-a": { "SKILL.md": "# A" },
    });
    const targetRoot = await createTempDir(tempDirs);
    await createSkillDir(targetRoot, "skill-a", { "SKILL.md": "# A" });

    const result = await installSkills(targetRoot, {
      dryRun: true,
      force: false,
      packageRoot,
    });

    expect(result.ok).toBe(true);
    expect(actionMap(result)).toEqual({ "skill-a": "unchanged" });
  });
});

describe("installSkills - validation failures", () => {
  test("rejects missing target parent directory", async () => {
    const packageRoot = await createPackageRoot(tempDirs, {
      "skill-a": { "SKILL.md": "# A" },
    });
    const targetRoot = join(
      await createTempDir(tempDirs),
      "does-not-exist",
      "skills",
    );

    await expect(
      installSkills(targetRoot, {
        dryRun: false,
        force: false,
        packageRoot,
      }),
    ).rejects.toThrow(InstallValidationError);
    await expect(
      installSkills(targetRoot, {
        dryRun: false,
        force: false,
        packageRoot,
      }),
    ).rejects.toThrow("does not exist");
  });

  test("rejects missing target parent for empty inventory including dry-run", async () => {
    const packageRoot = await createPackageRoot(tempDirs);
    const targetRoot = join(
      await createTempDir(tempDirs),
      "missing-parent",
      "skills",
    );

    await expect(
      installSkills(targetRoot, {
        dryRun: false,
        force: false,
        packageRoot,
      }),
    ).rejects.toThrow(InstallValidationError);
    await expect(
      installSkills(targetRoot, {
        dryRun: true,
        force: false,
        packageRoot,
      }),
    ).rejects.toThrow("does not exist");
    expect(await dirExists(targetRoot)).toBe(false);
  });

  test("rejects when target parent is not a directory", async () => {
    const packageRoot = await createPackageRoot(tempDirs, {
      "skill-a": { "SKILL.md": "# A" },
    });
    const base = await createTempDir(tempDirs);
    const parentFile = join(base, "not-a-dir");
    await writeFile(parentFile, "file");
    const targetRoot = join(parentFile, "skills");

    await expect(
      installSkills(targetRoot, {
        dryRun: false,
        force: false,
        packageRoot,
      }),
    ).rejects.toThrow(InstallValidationError);
    await expect(
      installSkills(targetRoot, {
        dryRun: false,
        force: false,
        packageRoot,
      }),
    ).rejects.toThrow("not a directory");
  });

  test("rejects when target parent is a file and inventory is empty", async () => {
    const packageRoot = await createPackageRoot(tempDirs);
    const base = await createTempDir(tempDirs);
    const parentFile = join(base, "not-a-dir");
    await writeFile(parentFile, "file");
    const targetRoot = join(parentFile, "skills");

    await expect(
      installSkills(targetRoot, {
        dryRun: false,
        force: false,
        packageRoot,
      }),
    ).rejects.toThrow(InstallValidationError);
    await expect(
      installSkills(targetRoot, {
        dryRun: false,
        force: false,
        packageRoot,
      }),
    ).rejects.toThrow("not a directory");
  });

  test("rejects when target path exists as a file", async () => {
    const packageRoot = await createPackageRoot(tempDirs, {
      "skill-a": { "SKILL.md": "# A" },
    });
    const base = await createTempDir(tempDirs);
    const targetRoot = join(base, "skills");
    await writeFile(targetRoot, "not a directory");

    await expect(
      installSkills(targetRoot, {
        dryRun: false,
        force: false,
        packageRoot,
      }),
    ).rejects.toThrow(InstallError);
    await expect(
      installSkills(targetRoot, {
        dryRun: false,
        force: false,
        packageRoot,
      }),
    ).rejects.toThrow("not a directory");
  });

  test("rejects no write access to target parent", async () => {
    if (process.getuid?.() === 0) {
      // Root bypasses permission checks
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
      ).rejects.toThrow(InstallValidationError);
      await expect(
        installSkills(targetRoot, {
          dryRun: false,
          force: false,
          packageRoot,
        }),
      ).rejects.toThrow("No write access");
      expect(await dirExists(targetRoot)).toBe(false);
    } finally {
      await chmod(parent, 0o755);
    }
  });

  test("surfaces permission-denied copy as a per-skill failure", async () => {
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

describe("installSkills - unsafe trees", () => {
  test("fails fatally on symlinked source skill directory", async () => {
    const packageRoot = await createPackageRoot(tempDirs);
    const skillsDir = join(packageRoot, "skills");
    const real = await createTempDir(tempDirs);
    await createSkillDir(real, "real-skill", { "SKILL.md": "# Real" });
    await symlink(
      join(real, "real-skill"),
      join(skillsDir, "link-skill"),
      "dir",
    );
    const targetRoot = await createTempDir(tempDirs);

    await expect(
      installSkills(targetRoot, {
        dryRun: false,
        force: false,
        packageRoot,
      }),
    ).rejects.toThrow(InstallError);
    await expect(
      installSkills(targetRoot, {
        dryRun: false,
        force: false,
        packageRoot,
      }),
    ).rejects.toThrow(/Source error|symlink/i);
  });

  test("fails fatally on symlinked target skill directory", async () => {
    const packageRoot = await createPackageRoot(tempDirs, {
      "skill-a": { "SKILL.md": "# A" },
    });
    const targetRoot = await createTempDir(tempDirs);
    const real = await createTempDir(tempDirs);
    await createSkillDir(real, "skill-a", { "SKILL.md": "# A" });
    await symlink(join(real, "skill-a"), join(targetRoot, "skill-a"), "dir");

    await expect(
      installSkills(targetRoot, {
        dryRun: false,
        force: false,
        packageRoot,
      }),
    ).rejects.toThrow(InstallError);
    await expect(
      installSkills(targetRoot, {
        dryRun: false,
        force: false,
        packageRoot,
      }),
    ).rejects.toThrow(/Target error|symlink/i);
  });
});

describe("installSkills - root validation", () => {
  test("rejects symlinked target root", async () => {
    const packageRoot = await createPackageRoot(tempDirs, {
      "skill-a": { "SKILL.md": "# A" },
    });
    const realTarget = await createTempDir(tempDirs);
    const linkBase = await createTempDir(tempDirs);
    await symlink(realTarget, join(linkBase, "link-root"), "dir");

    await expect(
      installSkills(join(linkBase, "link-root"), {
        dryRun: false,
        force: false,
        packageRoot,
      }),
    ).rejects.toThrow(InstallError);
    await expect(
      installSkills(join(linkBase, "link-root"), {
        dryRun: false,
        force: false,
        packageRoot,
      }),
    ).rejects.toThrow(/symlink/i);
  });

  test("rejects non-directory target root", async () => {
    const packageRoot = await createPackageRoot(tempDirs, {
      "skill-a": { "SKILL.md": "# A" },
    });
    const base = await createTempDir(tempDirs);
    const fileTarget = join(base, "not-a-dir");
    await writeFile(fileTarget, "file content");

    await expect(
      installSkills(fileTarget, {
        dryRun: false,
        force: false,
        packageRoot,
      }),
    ).rejects.toThrow(InstallError);
    await expect(
      installSkills(fileTarget, {
        dryRun: false,
        force: false,
        packageRoot,
      }),
    ).rejects.toThrow(/not a directory/i);
  });

  test("no mutation through symlinked target root", async () => {
    const packageRoot = await createPackageRoot(tempDirs, {
      "skill-a": { "SKILL.md": "# A" },
    });
    const realTarget = await createTempDir(tempDirs);
    const linkBase = await createTempDir(tempDirs);
    await symlink(realTarget, join(linkBase, "link-root"), "dir");

    const before = await readdir(realTarget);

    await expect(
      installSkills(join(linkBase, "link-root"), {
        dryRun: false,
        force: false,
        packageRoot,
      }),
    ).rejects.toThrow(InstallError);

    const after = await readdir(realTarget);
    expect(after).toEqual(before);
  });
});

describe("installSkills - absolute target resolution", () => {
  test("resolves relative target to absolute path in result", async () => {
    const packageRoot = await createPackageRoot(tempDirs, {
      "skill-a": { "SKILL.md": "# A" },
    });
    const base = await createTempDir(tempDirs);
    process.chdir(base);
    const relativeTarget = "rel-skills";

    const result = await installSkills(relativeTarget, {
      dryRun: true,
      force: false,
      packageRoot,
    });

    expect(result.target).toBe(join(base, relativeTarget));
    expect(result.target.startsWith("/")).toBe(true);
  });
});

describe("installSkills - missing package root", () => {
  test("surfaces missing skills directory as a source error", async () => {
    const packageRoot = await createTempDir(tempDirs);
    await writeFile(join(packageRoot, "package.json"), "{}\n");
    const targetRoot = await createTempDir(tempDirs);

    await expect(
      installSkills(targetRoot, {
        dryRun: false,
        force: false,
        packageRoot,
      }),
    ).rejects.toThrow(InstallError);
    await expect(
      installSkills(targetRoot, {
        dryRun: false,
        force: false,
        packageRoot,
      }),
    ).rejects.toThrow(/Skills directory does not exist/);
  });

  test("empty skills directory yields an empty, successful plan", async () => {
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

describe("installSkills — validateTargetParent edge cases", () => {
  test("rejects when target parent has no write access", async () => {
    const packageRoot = await createPackageRoot(tempDirs);
    // Create a parent directory that is read-only
    const base = await createTempDir(tempDirs);
    const parentDir = join(base, "readonly-parent");
    await mkdir(parentDir);
    const targetRoot = join(parentDir, "skills");
    await chmod(parentDir, 0o555);

    try {
      await expect(
        installSkills(targetRoot, {
          dryRun: false,
          force: false,
          packageRoot,
        }),
      ).rejects.toThrow(InstallValidationError);
      await expect(
        installSkills(targetRoot, {
          dryRun: false,
          force: false,
          packageRoot,
        }),
      ).rejects.toThrow(/No write access/);
    } finally {
      await chmod(parentDir, 0o755);
    }
  });

  test("surfaces generic computeSkillsInventory error as InstallError", async () => {
    const targetRoot = join(await createTempDir(tempDirs), "skills");

    // Mock computeSkillsInventory to throw a generic Error
    const skillsModule = await import("../src/utils/skills.js");
    const spy = spyOn(skillsModule, "computeSkillsInventory");
    spy.mockImplementation(() => {
      throw new Error("Unexpected runtime error");
    });

    try {
      await expect(
        installSkills(targetRoot, {
          dryRun: false,
          force: false,
        }),
      ).rejects.toThrow(InstallError);
      await expect(
        installSkills(targetRoot, {
          dryRun: false,
          force: false,
        }),
      ).rejects.toThrow(/Inventory failed/);
    } finally {
      spy.mockRestore();
    }
  });

  test("throws InstallError when validateTargetParent stat fails with non-ENOENT error", async () => {
    const packageRoot = await createPackageRoot(tempDirs, {
      "skill-a": { "SKILL.md": "# A" },
    });
    const parent = await createTempDir(tempDirs);
    const targetRoot = join(parent, "skills");

    const fsPromises = await import("node:fs/promises");
    const originalStat = fsPromises.stat;
    const spy = spyOn(fsPromises, "stat");
    spy.mockImplementation((async (p: string) => {
      if (p === parent) {
        const err = new Error(
          `EACCES: permission denied, stat '${p}'`,
        ) as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return originalStat(p);
    }) as typeof fsPromises.stat);

    try {
      await expect(
        installSkills(targetRoot, {
          dryRun: false,
          force: false,
          packageRoot,
        }),
      ).rejects.toThrow(InstallError);
      await expect(
        installSkills(targetRoot, {
          dryRun: false,
          force: false,
          packageRoot,
        }),
      ).rejects.toThrow(/Failed to inspect target parent/);
      expect(await dirExists(targetRoot)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test("surfaces cp failure as per-skill failure result", async () => {
    const packageRoot = await createPackageRoot(tempDirs, {
      "skill-a": { "SKILL.md": "# A" },
    });
    // Create a read-only target directory that mkdir will reuse
    const targetRoot = join(await createTempDir(tempDirs), "skills");
    await mkdir(targetRoot);
    await chmod(targetRoot, 0o555);

    try {
      // The root-guard on the existing test would skip this as root.
      // Running this regardless — if running as root, chmod 0o555 doesn't
      // prevent writes, so the operation would succeed. We skip the root
      // case by checking after the result.
      if (process.getuid?.() === 0) {
        // Restore permissions first
        await chmod(targetRoot, 0o755);
        return;
      }

      const result = await installSkills(targetRoot, {
        dryRun: false,
        force: false,
        packageRoot,
      });

      expect(result.ok).toBe(false);
      const failedSkill = result.skills.find((s) => s.action === "failed");
      expect(failedSkill).toBeDefined();
      expect(failedSkill?.error).toContain("EACCES");
    } finally {
      await chmod(targetRoot, 0o755);
    }
  });
});
