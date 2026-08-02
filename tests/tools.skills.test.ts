import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import {
  chmod,
  mkdir,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
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

/**
 * Deterministically deny `access(W_OK)` for exactly `targetRoot` by mocking
 * `node:fs/promises`, so denial holds even under UID 0 where chmod-based
 * permission checks are bypassed. Every other path falls through to the real
 * `access`, keeping target-parent preflight intact.
 */
function denyAccessToRoot(targetRoot: string): { restore: () => void } {
  const realAccess = fsPromises.access;
  const spy = spyOn(fsPromises, "access").mockImplementation(
    (path: string | URL | Buffer, mode?: number) => {
      if (resolve(String(path)) === resolve(targetRoot)) {
        return Promise.reject(
          Object.assign(
            new Error(`EACCES: permission denied, access '${targetRoot}'`),
            { code: "EACCES" },
          ),
        );
      }
      return realAccess(path, mode);
    },
  );
  return { restore: () => spy.mockRestore() };
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
    ).rejects.toThrow(InstallValidationError);
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

  test("rejects non-writable target root as InstallValidationError", async () => {
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
      ).rejects.toThrow(/No write access to target root/);
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

  test("rejects non-writable existing target root as InstallValidationError", async () => {
    const packageRoot = await createPackageRoot(tempDirs, {
      "skill-a": { "SKILL.md": "# A" },
    });
    // Create a read-only target directory that mkdir will reuse
    const targetRoot = join(await createTempDir(tempDirs), "skills");
    await mkdir(targetRoot);
    await chmod(targetRoot, 0o555);

    try {
      if (process.getuid?.() === 0) {
        await chmod(targetRoot, 0o755);
        return;
      }

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
      ).rejects.toThrow(/No write access to target root/);
    } finally {
      await chmod(targetRoot, 0o755);
    }
  });
});

describe("installSkills - root preflight validation", () => {
  test("rejects existing regular-file root in install path", async () => {
    const packageRoot = await createPackageRoot(tempDirs, {
      "skill-a": { "SKILL.md": "# A" },
    });
    const base = await createTempDir(tempDirs);
    const targetRoot = join(base, "not-a-dir");
    await writeFile(targetRoot, "file content");

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
    ).rejects.toThrow(/not a directory/);
  });

  test("rejects existing regular-file root in dry-run path", async () => {
    const packageRoot = await createPackageRoot(tempDirs, {
      "skill-a": { "SKILL.md": "# A" },
    });
    const base = await createTempDir(tempDirs);
    const targetRoot = join(base, "not-a-dir");
    await writeFile(targetRoot, "file content");

    await expect(
      installSkills(targetRoot, {
        dryRun: true,
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
    ).rejects.toThrow(/not a directory/);
  });

  test("rejects non-writable existing directory root in install path", async () => {
    const packageRoot = await createPackageRoot(tempDirs, {
      "skill-a": { "SKILL.md": "# A" },
    });
    const targetRoot = await createTempDir(tempDirs);
    const deny = denyAccessToRoot(targetRoot);

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
      ).rejects.toThrow(/No write access to target root/);
    } finally {
      deny.restore();
    }
  });

  test("rejects non-writable existing directory root in dry-run path", async () => {
    const packageRoot = await createPackageRoot(tempDirs, {
      "skill-a": { "SKILL.md": "# A" },
    });
    const targetRoot = await createTempDir(tempDirs);
    const deny = denyAccessToRoot(targetRoot);

    try {
      await expect(
        installSkills(targetRoot, {
          dryRun: true,
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
      ).rejects.toThrow(/No write access to target root/);
    } finally {
      deny.restore();
    }
  });

  test("absent roots beneath writable parents retain current behavior", async () => {
    const packageRoot = await createPackageRoot(tempDirs, {
      "skill-a": { "SKILL.md": "# A" },
    });
    const base = await createTempDir(tempDirs);
    const targetRoot = join(base, "new-skills");

    const result = await installSkills(targetRoot, {
      dryRun: false,
      force: false,
      packageRoot,
    });

    expect(result.ok).toBe(true);
    expect(actionMap(result)).toEqual({ "skill-a": "installed" });
    expect(await dirExists(join(targetRoot, "skill-a"))).toBe(true);
  });

  test("no mutation on existing regular-file root rejection", async () => {
    const packageRoot = await createPackageRoot(tempDirs, {
      "skill-a": { "SKILL.md": "# A" },
    });
    const base = await createTempDir(tempDirs);
    const targetRoot = join(base, "not-a-dir");
    await writeFile(targetRoot, "file content");
    const before = await readDirTree(base);

    await expect(
      installSkills(targetRoot, {
        dryRun: false,
        force: false,
        packageRoot,
      }),
    ).rejects.toThrow(InstallValidationError);

    expect(await readDirTree(base)).toEqual(before);
  });

  test("no mutation on non-writable directory root rejection", async () => {
    const packageRoot = await createPackageRoot(tempDirs, {
      "skill-a": { "SKILL.md": "# A" },
    });
    const targetRoot = await createTempDir(tempDirs);
    const before = await readDirTree(targetRoot);
    const deny = denyAccessToRoot(targetRoot);

    try {
      await expect(
        installSkills(targetRoot, {
          dryRun: false,
          force: false,
          packageRoot,
        }),
      ).rejects.toThrow(InstallValidationError);

      expect(await readDirTree(targetRoot)).toEqual(before);
    } finally {
      deny.restore();
    }
  });
});

describe("installSkills - computeInventory ENOTDIR conversion", () => {
  test("converts SkillTargetError ENOTDIR to InstallValidationError", async () => {
    const packageRoot = await createPackageRoot(tempDirs);
    const targetRoot = join(await createTempDir(tempDirs), "skills");

    // Mock computeSkillsInventory to throw SkillTargetError with ENOTDIR.
    const skillsModule = await import("../src/utils/skills.js");
    const spy = spyOn(skillsModule, "computeSkillsInventory");
    const { SkillTargetError } = skillsModule;
    spy.mockImplementation(() => {
      throw new SkillTargetError(
        "ENOTDIR: not a directory, lstat '/some/path'",
      );
    });

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
      ).rejects.toThrow(/is not a directory/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("installSkills - validateTargetParent non-directory parent", () => {
  test("rejects when parent exists but stat reports non-directory after lstatSync returns ENOENT", async () => {
    const packageRoot = await createTempDir(tempDirs, "vibe-pkg-");
    await writeFile(
      join(packageRoot, "package.json"),
      '{"name":"test-package"}',
    );
    await mkdir(join(packageRoot, "skills"));
    const base = await createTempDir(tempDirs);
    const parentDir = join(base, "actual-parent-dir");
    await mkdir(parentDir);
    const targetRoot = join(parentDir, "skills");

    const fsPromises = await import("node:fs/promises");
    const originalLstat = fsPromises.lstat;
    const lstatSpy = spyOn(fsPromises, "lstat");
    lstatSpy.mockImplementation(((
      p: Parameters<typeof fsPromises.lstat>[0],
    ) => {
      if (typeof p === "string" && p === targetRoot) {
        const err = new Error("ENOENT: no such file") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return originalLstat(p);
    }) as typeof fsPromises.lstat);

    const originalStat = fsPromises.stat;
    const statSpy = spyOn(fsPromises, "stat");
    statSpy.mockImplementation(((p: Parameters<typeof fsPromises.stat>[0]) => {
      if (typeof p === "string" && p === parentDir) {
        return Promise.resolve({
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
        } as unknown as Awaited<ReturnType<typeof fsPromises.stat>>);
      }
      return originalStat(p);
    }) as typeof fsPromises.stat);

    const nodeFs = await import("node:fs");
    const originalLstatSync = nodeFs.lstatSync;
    const lstatSyncSpy = spyOn(nodeFs, "lstatSync");
    lstatSyncSpy.mockImplementation(((
      p: Parameters<typeof nodeFs.lstatSync>[0],
    ) => {
      if (typeof p === "string" && p === targetRoot) {
        const err = new Error("ENOENT: no such file") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return originalLstatSync(p);
    }) as typeof nodeFs.lstatSync);

    try {
      await expect(
        installSkills(targetRoot, {
          dryRun: true,
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
      ).rejects.toThrow(/is not a directory/);
    } finally {
      lstatSpy.mockRestore();
      statSpy.mockRestore();
      lstatSyncSpy.mockRestore();
    }
  });
});

describe("installSkills - mkdir failure", () => {
  test("throws InstallError when mkdir fails", async () => {
    const packageRoot = await createPackageRoot(tempDirs, {
      "skill-a": { "SKILL.md": "# A" },
    });
    const targetRoot = join(await createTempDir(tempDirs), "skills");

    const fsPromises = await import("node:fs/promises");
    const spy = spyOn(fsPromises, "mkdir");
    spy.mockImplementation((() => {
      throw new Error("EACCES: permission denied");
    }) as typeof fsPromises.mkdir);

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
      ).rejects.toThrow(/Failed to create target/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("installSkills - copy failure per-skill", () => {
  test("marks skill as failed when cp throws", async () => {
    const packageRoot = await createPackageRoot(tempDirs, {
      "skill-a": { "SKILL.md": "# A" },
      "skill-b": { "SKILL.md": "# B" },
    });
    const targetRoot = join(await createTempDir(tempDirs), "skills");

    const fsPromises = await import("node:fs/promises");
    const originalCp = fsPromises.cp;
    const spy = spyOn(fsPromises, "cp");
    let callCount = 0;
    spy.mockImplementation(((
      src: string,
      dest: string,
      opts?: Parameters<typeof fsPromises.cp>[2],
    ) => {
      callCount++;
      if (callCount === 1) {
        // First call is skill-a — succeed
        return originalCp(src, dest, opts);
      }
      // Second call is skill-b — fail
      throw new Error("ENOSPC: no space left on device");
    }) as typeof fsPromises.cp);

    try {
      const result = await installSkills(targetRoot, {
        dryRun: false,
        force: false,
        packageRoot,
      });

      expect(result.ok).toBe(false);
      const actions = Object.fromEntries(
        result.skills.map((s) => [
          s.name,
          { action: s.action, error: s.error },
        ]),
      );
      expect(actions["skill-a"]).toEqual({
        action: "installed",
        error: undefined,
      });
      const skillB = actions["skill-b"];
      if (!skillB) throw new Error("Expected skill-b in actions");
      expect(skillB.action).toBe("failed");
      expect(skillB.error).toContain("ENOSPC");
      // skill-a was installed before skill-b failed
      expect(await dirExists(join(targetRoot, "skill-a"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test("reports ok false when any skill copy fails", async () => {
    const packageRoot = await createPackageRoot(tempDirs, {
      "skill-a": { "SKILL.md": "# A" },
    });
    const targetRoot = join(await createTempDir(tempDirs), "skills");

    const fsPromises = await import("node:fs/promises");
    const spy = spyOn(fsPromises, "cp");
    spy.mockImplementation(() => {
      throw new Error("EIO: i/o error");
    });

    try {
      const result = await installSkills(targetRoot, {
        dryRun: false,
        force: false,
        packageRoot,
      });

      expect(result.ok).toBe(false);
      const skill0 = result.skills[0];
      if (!skill0) throw new Error("Expected at least one skill");
      expect(skill0.action).toBe("failed");
      expect(skill0.error).toContain("EIO");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("installSkills - validateTargetRoot lstat non-ENOENT error", () => {
  test("throws InstallValidationError when lstat on targetRoot fails with non-ENOENT error", async () => {
    const packageRoot = await createPackageRoot(tempDirs, {
      "skill-a": { "SKILL.md": "# A" },
    });
    const base = await createTempDir(tempDirs);
    const targetRoot = join(base, "skills");
    await mkdir(targetRoot);

    const fsPromises = await import("node:fs/promises");
    const originalLstat = fsPromises.lstat;
    const spy = spyOn(fsPromises, "lstat");
    spy.mockImplementation(((p: Parameters<typeof fsPromises.lstat>[0]) => {
      if (typeof p === "string" && p === targetRoot) {
        const err = new Error(
          "EACCES: permission denied",
        ) as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return originalLstat(p);
    }) as typeof fsPromises.lstat);

    try {
      await expect(
        installSkills(targetRoot, {
          dryRun: true,
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
      ).rejects.toThrow(/Failed to inspect target root/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("installSkills - computeInventory SkillTargetError message routing", () => {
  test("routes SkillTargetError with 'is a symlink' to InstallValidationError", async () => {
    const packageRoot = await createPackageRoot(tempDirs);
    const targetRoot = join(await createTempDir(tempDirs), "skills");

    const skillsModule = await import("../src/utils/skills.js");
    const spy = spyOn(skillsModule, "computeSkillsInventory");
    const { SkillTargetError } = skillsModule;
    spy.mockImplementation(() => {
      throw new SkillTargetError("Target path component 'x' is a symlink");
    });

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
      ).rejects.toThrow(/Target error:.*symlink/);
    } finally {
      spy.mockRestore();
    }
  });

  test("routes SkillTargetError with 'No write access' to InstallValidationError", async () => {
    const packageRoot = await createPackageRoot(tempDirs);
    const targetRoot = join(await createTempDir(tempDirs), "skills");

    const skillsModule = await import("../src/utils/skills.js");
    const spy = spyOn(skillsModule, "computeSkillsInventory");
    const { SkillTargetError } = skillsModule;
    spy.mockImplementation(() => {
      throw new SkillTargetError("No write access to target root '/x'");
    });

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
    } finally {
      spy.mockRestore();
    }
  });

  test("routes generic SkillTargetError to InstallError", async () => {
    const packageRoot = await createPackageRoot(tempDirs);
    const targetRoot = join(await createTempDir(tempDirs), "skills");

    const skillsModule = await import("../src/utils/skills.js");
    const spy = spyOn(skillsModule, "computeSkillsInventory");
    const { SkillTargetError } = skillsModule;
    spy.mockImplementation(() => {
      throw new SkillTargetError("Some unexpected target fatal error");
    });

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
      ).rejects.toThrow(/Target error: Some unexpected/);
      // Does NOT surface as InstallValidationError
      await expect(
        installSkills(targetRoot, {
          dryRun: false,
          force: false,
          packageRoot,
        }),
      ).rejects.not.toThrow(InstallValidationError);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("installSkills - nested directory symlink in source skill", () => {
  test("rejects source skill with nested symlinked subdirectory", async () => {
    const packageRoot = await createPackageRoot(tempDirs);
    const skillsDir = join(packageRoot, "skills");
    // Create a real directory outside the skill
    const externalDir = await createTempDir(tempDirs);
    await writeFile(join(externalDir, "nested-file.txt"), "external");
    // Create a skill with a symlinked subdirectory pointing outside
    await createSkillDir(skillsDir, "my-skill", { "SKILL.md": "# My Skill" });
    await symlink(externalDir, join(skillsDir, "my-skill", "nested"), "dir");

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
    ).rejects.toThrow(/symlink/);
  });
});

describe("installSkills - nested file symlink in source skill", () => {
  test("rejects source skill with nested symlinked file", async () => {
    const packageRoot = await createPackageRoot(tempDirs);
    const skillsDir = join(packageRoot, "skills");
    // Create a real file outside the skill
    const externalFile = join(await createTempDir(tempDirs), "external.txt");
    await writeFile(externalFile, "external content");
    // Create a skill with a symlinked file inside
    await createSkillDir(skillsDir, "my-skill", { "SKILL.md": "# My Skill" });
    await symlink(
      externalFile,
      join(skillsDir, "my-skill", "link.txt"),
      "file",
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
    ).rejects.toThrow(/symlink/);
  });
});

describe("installSkills - SKILL.md not a regular file", () => {
  test("rejects source skill when SKILL.md is a directory", async () => {
    const packageRoot = await createPackageRoot(tempDirs);
    const skillsDir = join(packageRoot, "skills");
    // Create a skill where SKILL.md is actually a directory
    await mkdir(join(skillsDir, "my-skill"), { recursive: true });
    await mkdir(join(skillsDir, "my-skill", "SKILL.md"));

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
    ).rejects.toThrow(/not a regular file/);
  });
});

describe("installSkills - source skill readdir failure", () => {
  test("rejects when skills directory cannot be read", async () => {
    const packageRoot = await createPackageRoot(tempDirs);
    const skillsDir = join(packageRoot, "skills");
    await createSkillDir(skillsDir, "my-skill", { "SKILL.md": "# My Skill" });
    // Remove read permission from skills directory
    await chmod(skillsDir, 0o222);

    const targetRoot = await createTempDir(tempDirs);

    try {
      await expect(
        installSkills(targetRoot, {
          dryRun: false,
          force: false,
          packageRoot,
        }),
      ).rejects.toThrow(InstallError);
    } finally {
      await chmod(skillsDir, 0o755);
    }
  });
});
