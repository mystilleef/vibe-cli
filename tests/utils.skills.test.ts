import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { PathLike } from "node:fs";
import { realpathSync } from "node:fs";
import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findPackageRoot } from "../src/utils/packageRoot.js";
import {
  computeSkillsInventory,
  discoverBundledSkills,
  readSkillTarget,
  resolveDefaultTargetRoot,
  resolveTargetRoot,
  SkillSourceError,
  SkillTargetError,
} from "../src/utils/skills.js";
import {
  cleanupTempDirs,
  createPackageRoot,
  createSkillDir,
  createTempDir,
} from "./helpers/skillsTestUtils.js";

let tempDirs: string[] = [];
let originalCwd: string;

beforeEach(async () => {
  tempDirs = [];
  originalCwd = process.cwd();
});

afterEach(async () => {
  process.chdir(originalCwd);
  await cleanupTempDirs(tempDirs);
});

describe("discoverBundledSkills", () => {
  test("discovers skills with SKILL.md in direct children of skills/", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");

    await createSkillDir(skillsDir, "skill-a", {
      "SKILL.md": "# Skill A",
      "script.sh": "echo a",
    });
    await createSkillDir(skillsDir, "skill-b", {
      "SKILL.md": "# Skill B",
      "script.sh": "echo b",
    });

    const skills = discoverBundledSkills({ packageRoot: root });

    expect(skills).toHaveLength(2);
    expect(skills[0]?.name).toBe("skill-a");
    expect(skills[1]?.name).toBe("skill-b");
    expect(skills[0]?.files.map((f) => f.relativePath).sort()).toEqual([
      "SKILL.md",
      "script.sh",
    ]);
    expect(skills[1]?.files.map((f) => f.relativePath).sort()).toEqual([
      "SKILL.md",
      "script.sh",
    ]);
  });

  test("returns skills in lexical order", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");

    await createSkillDir(skillsDir, "zebra", { "SKILL.md": "# Z" });
    await createSkillDir(skillsDir, "alpha", { "SKILL.md": "# A" });
    await createSkillDir(skillsDir, "beta", { "SKILL.md": "# B" });

    const skills = discoverBundledSkills({ packageRoot: root });

    expect(skills.map((s) => s.name)).toEqual(["alpha", "beta", "zebra"]);
  });

  test("rejects directories without SKILL.md", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");

    await createSkillDir(skillsDir, "valid-skill", { "SKILL.md": "# Valid" });
    await mkdir(join(skillsDir, "not-a-skill"), { recursive: true });
    await writeFile(
      join(skillsDir, "not-a-skill", "README.md"),
      "# Not a skill",
    );

    expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
      SkillSourceError,
    );
    expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
      /SKILL\.md/i,
    );
  });

  test("malformed candidates beside valid bundles prevent partial inventory", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");

    await createSkillDir(skillsDir, "valid-skill", {
      "SKILL.md": "# Valid",
      "script.sh": "echo ok",
    });
    await mkdir(join(skillsDir, "malformed"), { recursive: true });
    await writeFile(join(skillsDir, "malformed", "README.md"), "# Not a skill");

    // Valid source tree preserved after rejection.
    const validPath = join(skillsDir, "valid-skill", "SKILL.md");
    const { readFileSync } = await import("node:fs");
    const contentBefore = readFileSync(validPath, "utf8");

    expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
      SkillSourceError,
    );

    const contentAfter = readFileSync(validPath, "utf8");
    expect(contentAfter).toBe(contentBefore);
  });

  test("ignores files in skills/ directory", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");

    await createSkillDir(skillsDir, "skill-a", { "SKILL.md": "# A" });
    await writeFile(join(skillsDir, "README.md"), "# Skills");

    const skills = discoverBundledSkills({ packageRoot: root });

    expect(skills).toHaveLength(1);
  });

  test("rejects symlinked skill directories", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");

    const realSkill = await createTempDir(tempDirs);
    await createSkillDir(realSkill, "real-skill", { "SKILL.md": "# Real" });

    // Symlink the actual skill directory (not its parent)
    const linkSkill = join(skillsDir, "link-skill");
    await symlink(join(realSkill, "real-skill"), linkSkill, "dir");

    expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
      SkillSourceError,
    );
    expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
      "symlink",
    );
  });

  test("rejects skill with symlinked SKILL.md", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");

    const skillDir = join(skillsDir, "bad-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md.real"), "# Real");
    await symlink(join(skillDir, "SKILL.md.real"), join(skillDir, "SKILL.md"));

    expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
      SkillSourceError,
    );
    expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
      "symlinked SKILL.md",
    );
  });

  test("throws SkillSourceError when skills/ directory does not exist", async () => {
    const root = await createTempDir(tempDirs);
    await writeFile(join(root, "package.json"), '{"name": "test"}');
    // No skills directory

    expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
      SkillSourceError,
    );
    expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
      /skills/i,
    );
  });

  test("returns empty array for empty skills/ directory", async () => {
    const root = await createPackageRoot(tempDirs);

    const skills = discoverBundledSkills({ packageRoot: root });

    expect(skills).toEqual([]);
  });

  test("throws SkillSourceError when skills/ is a symlink", async () => {
    const root = await createTempDir(tempDirs);
    await writeFile(join(root, "package.json"), '{"name": "test"}');
    const realSkills = await createTempDir(tempDirs);
    await createSkillDir(realSkills, "skill-a", { "SKILL.md": "# A" });
    await symlink(realSkills, join(root, "skills"), "dir");

    expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
      SkillSourceError,
    );
    expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
      /symlink|not a real/i,
    );
  });

  test("throws SkillSourceError when skills/ is not a directory", async () => {
    const root = await createTempDir(tempDirs);
    await writeFile(join(root, "package.json"), '{"name": "test"}');
    await writeFile(join(root, "skills"), "not-a-dir");

    expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
      SkillSourceError,
    );
  });

  test("throws SkillSourceError when skills/ directory is unreadable", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");
    await createSkillDir(skillsDir, "skill-a", { "SKILL.md": "# A" });

    try {
      await chmod(skillsDir, 0o000);
      expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
        SkillSourceError,
      );
      expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
        /Failed to read skills directory/i,
      );
    } finally {
      await chmod(skillsDir, 0o755);
    }
  });

  test("throws SkillSourceError when source skill file is unreadable", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");
    await createSkillDir(skillsDir, "skill-a", {
      "SKILL.md": "# A",
      "secret.txt": "secret",
    });
    const secret = join(skillsDir, "skill-a", "secret.txt");

    try {
      await chmod(secret, 0o000);
      expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
        SkillSourceError,
      );
    } finally {
      await chmod(secret, 0o644);
    }
  });

  test("throws SkillSourceError when SKILL.md is not a regular file", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillDir = join(root, "skills", "bad-skill");
    await mkdir(join(skillDir, "SKILL.md"), { recursive: true });

    expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
      SkillSourceError,
    );
    expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
      /SKILL\.md/i,
    );
  });

  test("computes deterministic SHA-256 hashes for skill files", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");

    await createSkillDir(skillsDir, "skill-a", {
      "SKILL.md": "# Skill A",
      "file.txt": "content",
    });

    const skills = discoverBundledSkills({ packageRoot: root });

    expect(skills[0]?.hash).toBeDefined();
    expect(skills[0]?.hash).toHaveLength(64); // SHA-256 hex
    expect(skills[0]?.files.every((f) => f.hash.length === 64)).toBe(true);
  });

  test("hash changes when file content changes", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");

    await createSkillDir(skillsDir, "skill-a", {
      "SKILL.md": "# Skill A",
      "file.txt": "content v1",
    });
    const skills1 = discoverBundledSkills({ packageRoot: root });
    const hash1 = skills1[0]?.hash;

    // Modify file
    await writeFile(join(skillsDir, "skill-a", "file.txt"), "content v2");
    const skills2 = discoverBundledSkills({ packageRoot: root });
    const hash2 = skills2[0]?.hash;

    expect(hash1).not.toBe(hash2);
  });

  test("hash changes when file is added", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");

    await createSkillDir(skillsDir, "skill-a", { "SKILL.md": "# Skill A" });
    const skills1 = discoverBundledSkills({ packageRoot: root });
    const hash1 = skills1[0]?.hash;

    // Add file
    await writeFile(join(skillsDir, "skill-a", "new.txt"), "new");
    const skills2 = discoverBundledSkills({ packageRoot: root });
    const hash2 = skills2[0]?.hash;

    expect(hash1).not.toBe(hash2);
  });

  test("hash changes when file is removed", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");

    await createSkillDir(skillsDir, "skill-a", {
      "SKILL.md": "# Skill A",
      "file.txt": "content",
    });
    const skills1 = discoverBundledSkills({ packageRoot: root });
    const hash1 = skills1[0]?.hash;

    // Remove file
    await rm(join(skillsDir, "skill-a", "file.txt"));
    const skills2 = discoverBundledSkills({ packageRoot: root });
    const hash2 = skills2[0]?.hash;

    expect(hash1).not.toBe(hash2);
  });

  test("walks nested directories in lexical order", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");

    await createSkillDir(skillsDir, "skill-a", {
      "SKILL.md": "# A",
      "a/z.txt": "z",
      "a/a.txt": "a",
      "b.txt": "b",
    });

    const skills = discoverBundledSkills({ packageRoot: root });
    const paths = skills[0]?.files.map((f) => f.relativePath);

    expect(paths).toEqual(["SKILL.md", "a/a.txt", "a/z.txt", "b.txt"]);
  });

  test("throws SkillSourceError for nested symlink inside skill directory", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");

    const skillDir = join(skillsDir, "skill-a");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# A");
    await writeFile(join(skillDir, "real.txt"), "real");
    await symlink(join(skillDir, "real.txt"), join(skillDir, "link.txt"));

    expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
      SkillSourceError,
    );
    expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
      /symlink/i,
    );
  });

  test("throws SkillSourceError for nested symlinked directory inside skill", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");
    const skillDir = join(skillsDir, "skill-a");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# A");

    const external = await createTempDir(tempDirs);
    await writeFile(join(external, "nested.txt"), "x");
    await symlink(external, join(skillDir, "nested-dir"), "dir");

    expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
      SkillSourceError,
    );
    expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
      /symlink/i,
    );
  });

  test("hash differs for path-only rename with identical bytes", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");

    await createSkillDir(skillsDir, "skill-a", {
      "SKILL.md": "# A",
      "alpha.txt": "same-bytes",
    });
    const hashBefore = discoverBundledSkills({ packageRoot: root })[0]?.hash;

    await rm(join(skillsDir, "skill-a", "alpha.txt"));
    await writeFile(join(skillsDir, "skill-a", "beta.txt"), "same-bytes");
    const hashAfter = discoverBundledSkills({ packageRoot: root })[0]?.hash;

    expect(hashBefore).toBeDefined();
    expect(hashAfter).toBeDefined();
    expect(hashBefore).not.toBe(hashAfter);
  });

  test("does not create skills/ or other paths during discovery", async () => {
    const root = await createTempDir(tempDirs);
    await writeFile(join(root, "package.json"), '{"name": "test"}');
    const before = await import("node:fs/promises").then((fs) =>
      fs.readdir(root),
    );

    expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
      SkillSourceError,
    );

    const after = await import("node:fs/promises").then((fs) =>
      fs.readdir(root),
    );
    expect(after).toEqual(before);
  });
});

describe("readSkillTarget", () => {
  test("returns null for missing target directory", async () => {
    const targetRoot = await createTempDir(tempDirs);

    const result = readSkillTarget("missing-skill", targetRoot);

    expect(result).toBeNull();
  });

  test("reads target skill directory with files and hashes", async () => {
    const targetRoot = await createTempDir(tempDirs);
    const skillDir = join(targetRoot, "skill-a");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# Skill A");
    await writeFile(join(skillDir, "script.sh"), "echo hello");

    const result = readSkillTarget("skill-a", targetRoot);

    expect(result).not.toBeNull();
    expect(result?.name).toBe("skill-a");
    expect(result?.targetPath).toBe(skillDir);
    expect(result?.files.map((f) => f.relativePath).sort()).toEqual([
      "SKILL.md",
      "script.sh",
    ]);
    expect(result?.hash).toHaveLength(64);
  });

  test("returns files in lexical order", async () => {
    const targetRoot = await createTempDir(tempDirs);
    const skillDir = join(targetRoot, "skill-a");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "z.txt"), "z");
    await writeFile(join(skillDir, "a.txt"), "a");
    await writeFile(join(skillDir, "SKILL.md"), "# A");

    const result = readSkillTarget("skill-a", targetRoot);

    expect(result?.files.map((f) => f.relativePath)).toEqual([
      "SKILL.md",
      "a.txt",
      "z.txt",
    ]);
  });

  test("throws SkillTargetError for symlinked target directory", async () => {
    const targetRoot = await createTempDir(tempDirs);
    const realDir = await createTempDir(tempDirs);
    await mkdir(join(realDir, "skill-a"), { recursive: true });
    await writeFile(join(realDir, "skill-a", "SKILL.md"), "# A");

    await symlink(join(realDir, "skill-a"), join(targetRoot, "skill-a"), "dir");

    expect(() => readSkillTarget("skill-a", targetRoot)).toThrow(
      SkillTargetError,
    );
    expect(() => readSkillTarget("skill-a", targetRoot)).toThrow("symlink");
  });

  test("throws SkillTargetError for symlinked file in target", async () => {
    const targetRoot = await createTempDir(tempDirs);
    const skillDir = join(targetRoot, "skill-a");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# A");
    await writeFile(join(skillDir, "real.txt"), "real");
    await symlink(join(skillDir, "real.txt"), join(skillDir, "link.txt"));

    expect(() => readSkillTarget("skill-a", targetRoot)).toThrow(
      SkillTargetError,
    );
    expect(() => readSkillTarget("skill-a", targetRoot)).toThrow("symlink");
  });

  test("throws SkillTargetError for unreadable target file", async () => {
    const targetRoot = await createTempDir(tempDirs);
    const skillDir = join(targetRoot, "skill-a");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# A");
    await writeFile(join(skillDir, "secret.txt"), "secret");

    // Make file unreadable (if possible on this platform)
    try {
      await import("node:fs").then((fs) =>
        fs.chmodSync(join(skillDir, "secret.txt"), 0o000),
      );
      expect(() => readSkillTarget("skill-a", targetRoot)).toThrow(
        SkillTargetError,
      );
    } finally {
      // Restore permissions for cleanup
      await import("node:fs").then((fs) =>
        fs.chmodSync(join(skillDir, "secret.txt"), 0o644),
      );
    }
  });
});

describe("computeSkillsInventory", () => {
  test("reports missing for skills not in target", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");

    await createSkillDir(skillsDir, "skill-a", { "SKILL.md": "# A" });
    await createSkillDir(skillsDir, "skill-b", { "SKILL.md": "# B" });

    const targetRoot = await createTempDir(tempDirs);

    const inventory = computeSkillsInventory(targetRoot, { packageRoot: root });

    expect(inventory.targetRoot).toBe(targetRoot);
    expect(inventory.skills).toHaveLength(2);
    expect(inventory.skills[0]).toBeDefined();
    expect(inventory.skills[1]).toBeDefined();
    expect(inventory.skills[0]).toMatchObject({
      name: "skill-a",
      status: "missing",
    });
    expect(inventory.skills[1]).toMatchObject({
      name: "skill-b",
      status: "missing",
    });
  });

  test("reports up-to-date for matching hashes", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");

    await createSkillDir(skillsDir, "skill-a", {
      "SKILL.md": "# A",
      "file.txt": "content",
    });

    const targetRoot = await createTempDir(tempDirs);
    const targetSkillDir = join(targetRoot, "skill-a");
    await mkdir(targetSkillDir, { recursive: true });
    await writeFile(join(targetSkillDir, "SKILL.md"), "# A");
    await writeFile(join(targetSkillDir, "file.txt"), "content");

    const inventory = computeSkillsInventory(targetRoot, { packageRoot: root });

    expect(inventory.skills[0]).toBeDefined();
    expect(inventory.skills[0]).toMatchObject({
      name: "skill-a",
      status: "up-to-date",
    });
  });

  test("reports modified for hash mismatch", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");

    await createSkillDir(skillsDir, "skill-a", {
      "SKILL.md": "# A",
      "file.txt": "content v1",
    });

    const targetRoot = await createTempDir(tempDirs);
    const targetSkillDir = join(targetRoot, "skill-a");
    await mkdir(targetSkillDir, { recursive: true });
    await writeFile(join(targetSkillDir, "SKILL.md"), "# A");
    await writeFile(join(targetSkillDir, "file.txt"), "content v2"); // Different content

    const inventory = computeSkillsInventory(targetRoot, { packageRoot: root });

    expect(inventory.skills[0]?.status).toBe("modified");
  });

  test("reports modified when target has extra file", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");

    await createSkillDir(skillsDir, "skill-a", {
      "SKILL.md": "# A",
      "file.txt": "content",
    });

    const targetRoot = await createTempDir(tempDirs);
    const targetSkillDir = join(targetRoot, "skill-a");
    await mkdir(targetSkillDir, { recursive: true });
    await writeFile(join(targetSkillDir, "SKILL.md"), "# A");
    await writeFile(join(targetSkillDir, "file.txt"), "content");
    await writeFile(join(targetSkillDir, "extra.txt"), "extra"); // Extra file

    const inventory = computeSkillsInventory(targetRoot, { packageRoot: root });

    expect(inventory.skills[0]?.status).toBe("modified");
  });

  test("reports modified when target is missing file", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");

    await createSkillDir(skillsDir, "skill-a", {
      "SKILL.md": "# A",
      "file.txt": "content",
    });

    const targetRoot = await createTempDir(tempDirs);
    const targetSkillDir = join(targetRoot, "skill-a");
    await mkdir(targetSkillDir, { recursive: true });
    await writeFile(join(targetSkillDir, "SKILL.md"), "# A");
    // Missing file.txt

    const inventory = computeSkillsInventory(targetRoot, { packageRoot: root });

    expect(inventory.skills[0]?.status).toBe("modified");
  });

  test("detects line ending differences as modified", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");

    await createSkillDir(skillsDir, "skill-a", {
      "SKILL.md": "# A",
      "file.txt": "line1\nline2\n",
    });

    const targetRoot = await createTempDir(tempDirs);
    const targetSkillDir = join(targetRoot, "skill-a");
    await mkdir(targetSkillDir, { recursive: true });
    await writeFile(join(targetSkillDir, "SKILL.md"), "# A");
    await writeFile(join(targetSkillDir, "file.txt"), "line1\r\nline2\r\n"); // CRLF

    const inventory = computeSkillsInventory(targetRoot, { packageRoot: root });

    expect(inventory.skills[0]?.status).toBe("modified");
  });

  test("detects whitespace differences as modified", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");

    await createSkillDir(skillsDir, "skill-a", {
      "SKILL.md": "# A",
      "file.txt": "content",
    });

    const targetRoot = await createTempDir(tempDirs);
    const targetSkillDir = join(targetRoot, "skill-a");
    await mkdir(targetSkillDir, { recursive: true });
    await writeFile(join(targetSkillDir, "SKILL.md"), "# A");
    await writeFile(join(targetSkillDir, "file.txt"), "content "); // Trailing space

    const inventory = computeSkillsInventory(targetRoot, { packageRoot: root });

    expect(inventory.skills[0]?.status).toBe("modified");
  });

  test("returns skills in lexical order", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");

    await createSkillDir(skillsDir, "zebra", { "SKILL.md": "# Z" });
    await createSkillDir(skillsDir, "alpha", { "SKILL.md": "# A" });
    await createSkillDir(skillsDir, "beta", { "SKILL.md": "# B" });

    const targetRoot = await createTempDir(tempDirs);

    const inventory = computeSkillsInventory(targetRoot, { packageRoot: root });

    expect(inventory.skills.map((s) => s.name)).toEqual([
      "alpha",
      "beta",
      "zebra",
    ]);
  });

  test("throws on unsafe source (symlink)", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");

    // Create a real skill directory
    const realSkill = await createTempDir(tempDirs);
    await createSkillDir(realSkill, "real-skill", { "SKILL.md": "# Real" });

    // Symlink the actual skill directory (not its parent)
    await symlink(
      join(realSkill, "real-skill"),
      join(skillsDir, "link-skill"),
      "dir",
    );

    const targetRoot = await createTempDir(tempDirs);

    expect(() =>
      computeSkillsInventory(targetRoot, { packageRoot: root }),
    ).toThrow(SkillSourceError);
  });

  test("throws on unsafe target (symlink)", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");

    await createSkillDir(skillsDir, "skill-a", { "SKILL.md": "# A" });

    const targetRoot = await createTempDir(tempDirs);
    const realTarget = await createTempDir(tempDirs);
    await mkdir(join(realTarget, "skill-a"), { recursive: true });
    await writeFile(join(realTarget, "skill-a", "SKILL.md"), "# A");

    await symlink(
      join(realTarget, "skill-a"),
      join(targetRoot, "skill-a"),
      "dir",
    );

    expect(() =>
      computeSkillsInventory(targetRoot, { packageRoot: root }),
    ).toThrow(SkillTargetError);
  });

  test("reports modified for path-only rename with identical bytes", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");

    await createSkillDir(skillsDir, "skill-a", {
      "SKILL.md": "# A",
      "alpha.txt": "same-bytes",
    });

    const targetRoot = await createTempDir(tempDirs);
    const targetSkillDir = join(targetRoot, "skill-a");
    await mkdir(targetSkillDir, { recursive: true });
    await writeFile(join(targetSkillDir, "SKILL.md"), "# A");
    await writeFile(join(targetSkillDir, "beta.txt"), "same-bytes");

    const inventory = computeSkillsInventory(targetRoot, { packageRoot: root });

    expect(inventory.skills[0]?.status).toBe("modified");
  });

  test("absent target root remains deterministic without creating paths", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");
    await createSkillDir(skillsDir, "skill-a", { "SKILL.md": "# A" });

    const parent = await createTempDir(tempDirs);
    const absentTarget = join(parent, "does-not-exist");

    const inventory = computeSkillsInventory(absentTarget, {
      packageRoot: root,
    });

    expect(inventory.targetRoot).toBe(absentTarget);
    expect(inventory.skills).toHaveLength(1);
    expect(inventory.skills[0]?.status).toBe("missing");

    const { existsSync } = await import("node:fs");
    expect(existsSync(absentTarget)).toBe(false);
  });

  test("empty source inventory is deterministic for any target", async () => {
    const root = await createPackageRoot(tempDirs);
    const targetRoot = await createTempDir(tempDirs);

    const inventory = computeSkillsInventory(targetRoot, { packageRoot: root });

    expect(inventory.skills).toEqual([]);
    expect(inventory.targetRoot).toBe(targetRoot);
  });

  test("throws SkillSourceError for missing skills/ before target use", async () => {
    const root = await createTempDir(tempDirs);
    await writeFile(join(root, "package.json"), '{"name": "test"}');
    const targetRoot = await createTempDir(tempDirs);

    expect(() =>
      computeSkillsInventory(targetRoot, { packageRoot: root }),
    ).toThrow(SkillSourceError);
  });
});

describe("resolveTargetRoot", () => {
  test("resolves default target using homedir", () => {
    const result = resolveTargetRoot();
    // Should use the actual homedir
    expect(result).toContain(".agents/skills");
  });

  test("expands tilde to home directory", () => {
    const result = resolveTargetRoot("~/custom/path");
    expect(result).toContain("custom/path");
    expect(result.startsWith("/") || /^[A-Za-z]:/.test(result)).toBe(true);
  });

  test("resolves relative paths to absolute", () => {
    const result = resolveTargetRoot("relative/path");
    expect(result).toBe(join(process.cwd(), "relative/path"));
    expect(result.startsWith("/") || /^[A-Za-z]:/.test(result)).toBe(true);
  });

  test("resolves absolute paths unchanged in form", async () => {
    const dir = await createTempDir(tempDirs);
    const result = resolveTargetRoot(dir);
    expect(result).toBe(dir);
  });

  test("expands bare tilde to home directory", () => {
    const result = resolveTargetRoot("~");
    expect(result.length).toBeGreaterThan(1);
    expect(result.includes("~")).toBe(false);
  });
});

describe("resolveDefaultTargetRoot", () => {
  test("returns ~/.agents/skills using homedir", () => {
    const result = resolveDefaultTargetRoot();
    expect(result).toContain(".agents/skills");
  });
});

describe("discoverBundledSkills layout matrix", () => {
  async function writeBundledSkill(
    packageRoot: string,
    name: string,
    body: string,
  ): Promise<void> {
    const skillDir = join(packageRoot, "skills", name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), body);
  }

  test("discovers skills from local checkout layout via package-root lookup", async () => {
    const root = await createTempDir(tempDirs);
    await writeFile(join(root, "package.json"), '{"name":"vibe-cli"}');
    await writeBundledSkill(root, "alpha", "# Alpha\n");
    await writeBundledSkill(root, "beta", "# Beta\n");
    const start = join(root, "src", "utils");
    await mkdir(start, { recursive: true });

    const packageRoot = findPackageRoot(start);
    expect(packageRoot).toBe(realpathSync(root));
    const skills = discoverBundledSkills({ packageRoot });
    expect(skills.map((s) => s.name)).toEqual(["alpha", "beta"]);
  });

  test("discovers skills from linked package layout", async () => {
    const realRoot = await createTempDir(tempDirs);
    await writeFile(join(realRoot, "package.json"), '{"name":"vibe-cli"}');
    await writeBundledSkill(realRoot, "linked-skill", "# Linked\n");
    const realStart = join(realRoot, "src", "utils");
    await mkdir(realStart, { recursive: true });

    const linkHome = await createTempDir(tempDirs);
    const linkedPkg = join(linkHome, "linked-vibe");
    await symlink(realRoot, linkedPkg, "dir");

    const packageRoot = findPackageRoot(join(linkedPkg, "src", "utils"));
    expect(packageRoot).toBe(realpathSync(realRoot));
    const skills = discoverBundledSkills({ packageRoot });
    expect(skills.map((s) => s.name)).toEqual(["linked-skill"]);
  });

  test("discovers skills from global-style node_modules layout", async () => {
    const prefix = await createTempDir(tempDirs);
    const pkgRoot = join(
      prefix,
      "lib",
      "node_modules",
      "@mystilleef",
      "vibe-cli",
    );
    await mkdir(pkgRoot, { recursive: true });
    await writeFile(
      join(pkgRoot, "package.json"),
      '{"name":"@mystilleef/vibe-cli"}',
    );
    await writeBundledSkill(pkgRoot, "global-skill", "# Global\n");
    const start = join(pkgRoot, "dist");
    await mkdir(start, { recursive: true });

    const packageRoot = findPackageRoot(start);
    expect(packageRoot).toBe(realpathSync(pkgRoot));
    const skills = discoverBundledSkills({ packageRoot });
    expect(skills.map((s) => s.name)).toEqual(["global-skill"]);
  });

  test("discovers skills from packed-extraction layout", async () => {
    const extractRoot = await createTempDir(tempDirs);
    const pkgRoot = join(extractRoot, "package");
    await mkdir(pkgRoot, { recursive: true });
    await writeFile(join(pkgRoot, "package.json"), '{"name":"vibe-cli"}');
    await writeBundledSkill(pkgRoot, "packed-skill", "# Packed\n");
    const start = join(pkgRoot, "dist");
    await mkdir(start, { recursive: true });

    const packageRoot = findPackageRoot(start);
    expect(packageRoot).toBe(realpathSync(pkgRoot));
    const skills = discoverBundledSkills({ packageRoot });
    expect(skills.map((s) => s.name)).toEqual(["packed-skill"]);
  });
});

describe("computeSkillsInventory — root validation", () => {
  test("throws SkillTargetError for symlinked target root", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");
    await createSkillDir(skillsDir, "skill-a", { "SKILL.md": "# A" });

    const realTarget = await createTempDir(tempDirs);
    const linkTarget = await createTempDir(tempDirs);
    await symlink(realTarget, join(linkTarget, "link-root"), "dir");

    expect(() =>
      computeSkillsInventory(join(linkTarget, "link-root"), {
        packageRoot: root,
      }),
    ).toThrow(SkillTargetError);
    expect(() =>
      computeSkillsInventory(join(linkTarget, "link-root"), {
        packageRoot: root,
      }),
    ).toThrow(/symlink/i);
  });

  test("throws SkillTargetError for non-directory target root", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");
    await createSkillDir(skillsDir, "skill-a", { "SKILL.md": "# A" });

    const base = await createTempDir(tempDirs);
    const fileTarget = join(base, "not-a-dir");
    await writeFile(fileTarget, "file content");

    expect(() =>
      computeSkillsInventory(fileTarget, { packageRoot: root }),
    ).toThrow(SkillTargetError);
    expect(() =>
      computeSkillsInventory(fileTarget, { packageRoot: root }),
    ).toThrow(/not a directory/i);
  });

  test("absent target root remains uncreated", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");
    await createSkillDir(skillsDir, "skill-a", { "SKILL.md": "# A" });

    const parent = await createTempDir(tempDirs);
    const absentTarget = join(parent, "does-not-exist");

    const inventory = computeSkillsInventory(absentTarget, {
      packageRoot: root,
    });

    expect(inventory.targetRoot).toBe(absentTarget);
    expect(inventory.skills).toHaveLength(1);
    expect(inventory.skills[0]?.status).toBe("missing");

    const { existsSync: fsExistsSync } = await import("node:fs");
    expect(fsExistsSync(absentTarget)).toBe(false);
  });

  test("safe target root retains existing list behavior", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");
    await createSkillDir(skillsDir, "skill-a", {
      "SKILL.md": "# A",
      "file.txt": "content",
    });

    const targetRoot = await createTempDir(tempDirs);
    const targetSkillDir = join(targetRoot, "skill-a");
    await mkdir(targetSkillDir, { recursive: true });
    await writeFile(join(targetSkillDir, "SKILL.md"), "# A");
    await writeFile(join(targetSkillDir, "file.txt"), "content");

    const inventory = computeSkillsInventory(targetRoot, {
      packageRoot: root,
    });

    expect(inventory.skills[0]).toMatchObject({
      name: "skill-a",
      status: "up-to-date",
    });
  });

  test("no mutation through symlinked target root", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");
    await createSkillDir(skillsDir, "skill-a", { "SKILL.md": "# A" });

    const realTarget = await createTempDir(tempDirs);
    const linkTarget = await createTempDir(tempDirs);
    await symlink(realTarget, join(linkTarget, "link-root"), "dir");

    const before = await import("node:fs/promises").then((fs) =>
      fs.readdir(realTarget),
    );

    expect(() =>
      computeSkillsInventory(join(linkTarget, "link-root"), {
        packageRoot: root,
      }),
    ).toThrow(SkillTargetError);

    const after = await import("node:fs/promises").then((fs) =>
      fs.readdir(realTarget),
    );
    expect(after).toEqual(before);
  });
});

describe("resolveTargetRoot — ~user expansion", () => {
  test("expands ~user forms by joining home with username", () => {
    const result = resolveTargetRoot("~someuser");
    expect(result).toContain("someuser");
    expect(result.includes("~")).toBe(false);
  });
});

describe("readSkillTarget — non-directory and error paths", () => {
  test("throws SkillTargetError when target is a regular file, not a directory", async () => {
    const targetRoot = await createTempDir(tempDirs);
    const filePath = join(targetRoot, "skill-a");
    await writeFile(filePath, "not a directory");

    expect(() => readSkillTarget("skill-a", targetRoot)).toThrow(
      SkillTargetError,
    );
    expect(() => readSkillTarget("skill-a", targetRoot)).toThrow(
      /not a directory/i,
    );
  });

  test("throws SkillTargetError when lstat fails with non-ENOENT error on target entry", async () => {
    const targetRoot = await createTempDir(tempDirs);

    const fsModule = await import("node:fs");
    const originalLstatSync = fsModule.lstatSync;
    const spy = spyOn(fsModule, "lstatSync");
    spy.mockImplementation(((p: string) => {
      if (p === join(targetRoot, "skill-a")) {
        const err = new Error(
          `EACCES: permission denied, lstat '${p}'`,
        ) as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return originalLstatSync(p);
    }) as typeof fsModule.lstatSync);

    try {
      expect(() => readSkillTarget("skill-a", targetRoot)).toThrow(
        SkillTargetError,
      );
      expect(() => readSkillTarget("skill-a", targetRoot)).toThrow(
        /Failed to stat target/i,
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("throws SkillTargetError when target SKILL.md check fails after walk due to missing entry", async () => {
    const targetRoot = await createTempDir(tempDirs);
    const skillDir = join(targetRoot, "skill-a");
    await mkdir(skillDir, { recursive: true });
    // Create a subdirectory named SKILL.md — walk descends into it but never adds it as a file
    await mkdir(join(skillDir, "SKILL.md"), { recursive: true });

    expect(() => readSkillTarget("skill-a", targetRoot)).toThrow(
      SkillTargetError,
    );
    expect(() => readSkillTarget("skill-a", targetRoot)).toThrow(
      /missing SKILL\.md/i,
    );
  });
});

describe("fail-closed inspection", () => {
  test("confirmed ENOENT root reports missing without creating paths", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");
    await createSkillDir(skillsDir, "skill-a", { "SKILL.md": "# A" });

    const parent = await createTempDir(tempDirs);
    const absentTarget = join(parent, "does-not-exist");

    const inventory = computeSkillsInventory(absentTarget, {
      packageRoot: root,
    });

    expect(inventory.skills[0]?.status).toBe("missing");
    const { existsSync: fsExistsSync } = await import("node:fs");
    expect(fsExistsSync(absentTarget)).toBe(false);
  });

  test("confirmed ENOENT entry reports missing via readSkillTarget", async () => {
    const targetRoot = await createTempDir(tempDirs);

    const result = readSkillTarget("missing-skill", targetRoot);

    expect(result).toBeNull();
  });

  test("symlink and non-directory rejection retain current behavior", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");
    await createSkillDir(skillsDir, "skill-a", { "SKILL.md": "# A" });

    const base = await createTempDir(tempDirs);
    const fileTarget = join(base, "not-a-dir");
    await writeFile(fileTarget, "content");

    expect(() =>
      computeSkillsInventory(fileTarget, { packageRoot: root }),
    ).toThrow(SkillTargetError);
    expect(() =>
      computeSkillsInventory(fileTarget, { packageRoot: root }),
    ).toThrow(/not a directory/i);
  });

  test("valid-tree hashes and statuses retain current behavior", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");
    await createSkillDir(skillsDir, "skill-a", {
      "SKILL.md": "# A",
      "file.txt": "content",
    });

    const targetRoot = await createTempDir(tempDirs);
    const targetSkillDir = join(targetRoot, "skill-a");
    await mkdir(targetSkillDir, { recursive: true });
    await writeFile(join(targetSkillDir, "SKILL.md"), "# A");
    await writeFile(join(targetSkillDir, "file.txt"), "content");

    const inventory = computeSkillsInventory(targetRoot, {
      packageRoot: root,
    });

    expect(inventory.skills[0]).toMatchObject({
      name: "skill-a",
      status: "up-to-date",
    });
    expect(inventory.skills[0]?.source?.hash).toHaveLength(64);
    expect(inventory.skills[0]?.target?.hash).toHaveLength(64);
    expect(inventory.skills[0]?.source?.hash).toBe(
      inventory.skills[0]?.target?.hash,
    );
  });
});

describe("walkSkillDirectory — file read failure", () => {
  test("throws SkillSourceError when readdirSync fails at skill directory top level", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");
    await createSkillDir(skillsDir, "skill-a", { "SKILL.md": "# A" });

    const fsModule = await import("node:fs");
    const originalReaddirSync = fsModule.readdirSync;
    const spy = spyOn(fsModule, "readdirSync");
    spy.mockImplementation(((p: PathLike) => {
      // Fail on the skill-a directory itself, not on nested paths
      const pathStr = String(p);
      if (pathStr.endsWith("skill-a") && !pathStr.includes("nested")) {
        const err = new Error(
          `EACCES: permission denied, scandir '${pathStr}'`,
        ) as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return originalReaddirSync(p);
    }) as typeof fsModule.readdirSync);

    try {
      expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
        SkillSourceError,
      );
      expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
        /Failed to read directory/i,
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("throws SkillSourceError when a file becomes unreadable after lstat succeeds", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");
    await createSkillDir(skillsDir, "skill-a", {
      "SKILL.md": "# A",
      "broken.txt": "should be unreadable",
    });

    const brokenPath = join(skillsDir, "skill-a", "broken.txt");
    try {
      // Remove read permission so readFileSync fails (hashFile → throw).
      await chmod(brokenPath, 0o000);

      expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
        SkillSourceError,
      );
      expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
        /Failed to read file/i,
      );
    } finally {
      await chmod(brokenPath, 0o644);
    }
  });

  test("throws SkillTargetError when a target file becomes unreadable after lstat succeeds", async () => {
    const targetRoot = await createTempDir(tempDirs);
    const skillDir = join(targetRoot, "skill-a");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# A");
    await writeFile(join(skillDir, "secret.txt"), "sensitive");

    const brokenPath = join(skillDir, "secret.txt");
    try {
      await chmod(brokenPath, 0o000);

      expect(() => readSkillTarget("skill-a", targetRoot)).toThrow(
        SkillTargetError,
      );
      expect(() => readSkillTarget("skill-a", targetRoot)).toThrow(
        /Failed to read file/i,
      );
    } finally {
      await chmod(brokenPath, 0o644);
    }
  });
});

describe("walkSkillDirectory — non-regular file type", () => {
  test("throws SkillSourceError when a skill entry is a non-regular file (FIFO)", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");
    await createSkillDir(skillsDir, "skill-a", {
      "SKILL.md": "# A",
    });

    // Create a FIFO (named pipe) — not a regular file, not a directory, not a symlink.
    const fifoPath = join(skillsDir, "skill-a", "fifo-pipe");
    const { execSync } = await import("node:child_process");
    execSync(`mkfifo "${fifoPath}"`);

    try {
      expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
        SkillSourceError,
      );
      expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
        /not a regular file/i,
      );
    } finally {
      // Clean up FIFO.
      try {
        await rm(fifoPath, { force: true });
      } catch {
        // ignore
      }
    }
  });
});

describe("hashContent", () => {
  test("produces deterministic SHA-256 hex digest", async () => {
    const { hashContent } = await import("../src/utils/skills.js");
    const result = hashContent(Buffer.from("hello"));
    expect(result).toHaveLength(64);
    // Deterministic: same input → same hash
    const result2 = hashContent(Buffer.from("hello"));
    expect(result2).toBe(result);
  });

  test("different content produces different hashes", async () => {
    const { hashContent } = await import("../src/utils/skills.js");
    const a = hashContent(Buffer.from("hello"));
    const b = hashContent(Buffer.from("world"));
    expect(a).not.toBe(b);
  });

  test("empty buffer produces valid hash", async () => {
    const { hashContent } = await import("../src/utils/skills.js");
    const result = hashContent(Buffer.alloc(0));
    expect(result).toHaveLength(64);
  });
});

// ── listSkillDirectories entry-level lstat fault ────────────────────────

describe("walkSkillDirectory — escape detection is defensive", () => {
  test("symlinked directories are rejected as symlinks, not as escapes", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");
    const skillDir = join(skillsDir, "skill-a");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# A");

    const externalDir = await createTempDir(tempDirs);
    await writeFile(join(externalDir, "escape.txt"), "escaped");

    // A symlinked subdirectory is caught by the isSymbolicLink check before
    // the escape check can fire.
    await symlink(externalDir, join(skillDir, "link-out"), "dir");

    expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
      SkillSourceError,
    );
    // The symlink rejection fires first, not the escape message.
    expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
      /is a symlink/i,
    );
  });
});
describe("walkSkillDirectory — realpathSync failure", () => {
  test("throws SkillSourceError when realpathSync fails on nested directory", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");
    const skillDir = join(skillsDir, "skill-a");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# A");
    const nestedDir = join(skillDir, "nested");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(join(nestedDir, "nested.txt"), "data");

    const fsModule = await import("node:fs");
    const originalRealpathSync = fsModule.realpathSync;
    const spy = spyOn(fsModule, "realpathSync");
    spy.mockImplementation(((p: string) => {
      if (p === nestedDir) {
        const err = new Error(
          `EIO: i/o error, realpath '${p}'`,
        ) as NodeJS.ErrnoException;
        err.code = "EIO";
        throw err;
      }
      return originalRealpathSync(p);
    }) as typeof fsModule.realpathSync);

    try {
      expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
        SkillSourceError,
      );
      expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
        /Failed to resolve/i,
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("throws SkillTargetError when realpathSync fails on nested target directory", async () => {
    const targetRoot = await createTempDir(tempDirs);
    const skillDir = join(targetRoot, "skill-a");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# A");
    const nestedDir = join(skillDir, "nested");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(join(nestedDir, "nested.txt"), "data");

    const fsModule = await import("node:fs");
    const originalRealpathSync = fsModule.realpathSync;
    const spy = spyOn(fsModule, "realpathSync");
    spy.mockImplementation(((p: string) => {
      if (p === nestedDir) {
        const err = new Error(
          `EIO: i/o error, realpath '${p}'`,
        ) as NodeJS.ErrnoException;
        err.code = "EIO";
        throw err;
      }
      return originalRealpathSync(p);
    }) as typeof fsModule.realpathSync);

    try {
      expect(() => readSkillTarget("skill-a", targetRoot)).toThrow(
        SkillTargetError,
      );
      expect(() => readSkillTarget("skill-a", targetRoot)).toThrow(
        /Failed to resolve/i,
      );
    } finally {
      spy.mockRestore();
    }
  });
});

// ── walkSkillDirectory — mount escape detection ────────────────────────

describe("assertEntryType — stat failure on root directory", () => {
  test("throws SkillSourceError when lstatSync fails on skills directory", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");
    await createSkillDir(skillsDir, "skill-a", { "SKILL.md": "# A" });

    const fsModule = await import("node:fs");
    const originalLstatSync = fsModule.lstatSync;
    const spy = spyOn(fsModule, "lstatSync");
    spy.mockImplementation(((p: string) => {
      if (p === skillsDir) {
        const err = new Error(
          `EIO: i/o error, lstat '${p}'`,
        ) as NodeJS.ErrnoException;
        err.code = "EIO";
        throw err;
      }
      return originalLstatSync(p);
    }) as typeof fsModule.lstatSync);

    try {
      expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
        SkillSourceError,
      );
      expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
        /Failed to stat Skills directory/i,
      );
    } finally {
      spy.mockRestore();
    }
  });
});

describe("walkSkillDirectory — per-entry lstat failure on source side", () => {
  test("throws SkillSourceError when lstatSync fails on a file inside a source skill directory", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");
    await createSkillDir(skillsDir, "skill-a", {
      "SKILL.md": "# A",
      "script.sh": "echo hello",
    });

    const fsModule = await import("node:fs");
    const originalLstatSync = fsModule.lstatSync;
    const spy = spyOn(fsModule, "lstatSync");
    spy.mockImplementation(((p: string) => {
      // Fail on script.sh inside skill-a, but only from within walkSkillDirectory
      // We need to fail AFTER the SKILL.md check passes but DURING walk
      if (p === join(skillsDir, "skill-a", "script.sh")) {
        const err = new Error(
          `EIO: i/o error, lstat '${p}'`,
        ) as NodeJS.ErrnoException;
        err.code = "EIO";
        throw err;
      }
      return originalLstatSync(p);
    }) as typeof fsModule.lstatSync);

    try {
      expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
        SkillSourceError,
      );
      expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
        /Failed to stat/i,
      );
    } finally {
      spy.mockRestore();
    }
  });
});

describe("assertSafeRoot — non-ENOENT lstat failure", () => {
  test("throws SkillTargetError when lstat fails with EACCES", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");
    await createSkillDir(skillsDir, "skill-a", { "SKILL.md": "# A" });

    const targetRoot = await createTempDir(tempDirs);
    const fsModule = await import("node:fs");
    const originalLstatSync = fsModule.lstatSync;
    const spy = spyOn(fsModule, "lstatSync");
    spy.mockImplementation(((p: string) => {
      if (p === targetRoot) {
        const err = new Error(
          `EACCES: permission denied, lstat '${p}'`,
        ) as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return originalLstatSync(p);
    }) as typeof fsModule.lstatSync);

    try {
      expect(() =>
        computeSkillsInventory(targetRoot, { packageRoot: root }),
      ).toThrow(SkillTargetError);
      expect(() =>
        computeSkillsInventory(targetRoot, { packageRoot: root }),
      ).toThrow(/Failed to stat/i);
    } finally {
      spy.mockRestore();
    }
  });

  test("throws SkillTargetError when lstat fails with EIO", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");
    await createSkillDir(skillsDir, "skill-a", { "SKILL.md": "# A" });

    const targetRoot = await createTempDir(tempDirs);
    const fsModule = await import("node:fs");
    const originalLstatSync = fsModule.lstatSync;
    const spy = spyOn(fsModule, "lstatSync");
    spy.mockImplementation(((p: string) => {
      if (p === targetRoot) {
        const err = new Error(
          `EIO: i/o error, lstat '${p}'`,
        ) as NodeJS.ErrnoException;
        err.code = "EIO";
        throw err;
      }
      return originalLstatSync(p);
    }) as typeof fsModule.lstatSync);

    try {
      expect(() =>
        computeSkillsInventory(targetRoot, { packageRoot: root }),
      ).toThrow(SkillTargetError);
      expect(() =>
        computeSkillsInventory(targetRoot, { packageRoot: root }),
      ).toThrow(/Failed to stat/i);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("discoverBundledSkills — lstatSync failure on entry", () => {
  test("throws SkillSourceError when lstatSync fails on a skill directory entry", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");
    await createSkillDir(skillsDir, "skill-a", { "SKILL.md": "# A" });
    await createSkillDir(skillsDir, "skill-b", { "SKILL.md": "# B" });

    const fsModule = await import("node:fs");
    const originalLstatSync = fsModule.lstatSync;
    const spy = spyOn(fsModule, "lstatSync");
    spy.mockImplementation(((p: string) => {
      if (p === join(skillsDir, "skill-b")) {
        const err = new Error(
          `EIO: i/o error, lstat '${p}'`,
        ) as NodeJS.ErrnoException;
        err.code = "EIO";
        throw err;
      }
      return originalLstatSync(p);
    }) as typeof fsModule.lstatSync);

    try {
      expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
        SkillSourceError,
      );
      expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
        /Failed to stat/i,
      );
    } finally {
      spy.mockRestore();
    }
  });
});

describe("walkSkillDirectory — subdirectory readdir failure", () => {
  test("throws SkillSourceError when readdirSync fails on nested subdirectory", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");
    await createSkillDir(skillsDir, "skill-a", {
      "SKILL.md": "# A",
      "nested/file.txt": "data",
    });

    const fsModule = await import("node:fs");
    const originalReaddirSync = fsModule.readdirSync;
    const spy = spyOn(fsModule, "readdirSync");
    spy.mockImplementation(((p: PathLike) => {
      const pathStr = String(p);
      if (pathStr.includes("nested")) {
        const err = new Error(
          `EACCES: permission denied, scandir '${pathStr}'`,
        ) as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return originalReaddirSync(p);
    }) as typeof fsModule.readdirSync);

    try {
      expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
        SkillSourceError,
      );
      expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
        /Failed to read directory/i,
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("throws SkillTargetError when readdirSync fails on nested target subdirectory", async () => {
    const targetRoot = await createTempDir(tempDirs);
    const skillDir = join(targetRoot, "skill-a");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# A");
    const nestedDir = join(skillDir, "nested");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(join(nestedDir, "file.txt"), "data");

    const fsModule = await import("node:fs");
    const originalReaddirSync = fsModule.readdirSync;
    const spy = spyOn(fsModule, "readdirSync");
    spy.mockImplementation(((p: PathLike) => {
      const pathStr = String(p);
      if (pathStr.includes("nested")) {
        const err = new Error(
          `EACCES: permission denied, scandir '${pathStr}'`,
        ) as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return originalReaddirSync(p);
    }) as typeof fsModule.readdirSync);

    try {
      expect(() => readSkillTarget("skill-a", targetRoot)).toThrow(
        SkillTargetError,
      );
      expect(() => readSkillTarget("skill-a", targetRoot)).toThrow(
        /Failed to read directory/i,
      );
    } finally {
      spy.mockRestore();
    }
  });
});

describe("walkSkillDirectory — escape detection", () => {
  test("throws SkillSourceError when nested directory resolves outside skill root", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");
    const skillDir = join(skillsDir, "skill-a");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# A");
    const nestedDir = join(skillDir, "nested");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(join(nestedDir, "file.txt"), "data");

    // Make realpathSync for the nested directory return a path outside the
    // skill root, simulating a bind-mount escape. The directory is real
    // (not a symlink), so the earlier isSymbolicLink check passes.
    const externalDir = await createTempDir(tempDirs);
    const fsModule = await import("node:fs");
    const originalRealpathSync = fsModule.realpathSync;
    const spy = spyOn(fsModule, "realpathSync");
    spy.mockImplementation(((p: string) => {
      if (p === nestedDir) return externalDir;
      return originalRealpathSync(p);
    }) as typeof fsModule.realpathSync);

    try {
      expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
        SkillSourceError,
      );
      expect(() => discoverBundledSkills({ packageRoot: root })).toThrow(
        /escapes skill root/i,
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("throws SkillTargetError when nested target directory escapes target root", async () => {
    const targetRoot = await createTempDir(tempDirs);
    const skillDir = join(targetRoot, "skill-a");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# A");
    const nestedDir = join(skillDir, "nested");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(join(nestedDir, "file.txt"), "data");

    const externalDir = await createTempDir(tempDirs);
    const fsModule = await import("node:fs");
    const originalRealpathSync = fsModule.realpathSync;
    const spy = spyOn(fsModule, "realpathSync");
    spy.mockImplementation(((p: string) => {
      if (p === nestedDir) return externalDir;
      return originalRealpathSync(p);
    }) as typeof fsModule.realpathSync);

    try {
      expect(() => readSkillTarget("skill-a", targetRoot)).toThrow(
        SkillTargetError,
      );
      expect(() => readSkillTarget("skill-a", targetRoot)).toThrow(
        /escapes skill root/i,
      );
    } finally {
      spy.mockRestore();
    }
  });
});

// ── getSafeHomedir — error path when home cannot be determined ─────────

describe("resolveTargetRoot — home detection failure", () => {
  test("throws when home directory cannot be determined", async () => {
    const savedHome = process.env["HOME"];
    delete process.env["HOME"];

    const osModule = await import("node:os");
    const spy = spyOn(osModule, "homedir");
    spy.mockReturnValue("");

    try {
      expect(() => resolveDefaultTargetRoot()).toThrow(
        /Unable to determine home directory/i,
      );
    } finally {
      spy.mockRestore();
      if (savedHome !== undefined) {
        process.env["HOME"] = savedHome;
      }
    }
  });

  test("resolveTargetRoot throws when home cannot be determined with ~ expansion", async () => {
    const savedHome = process.env["HOME"];
    delete process.env["HOME"];

    const osModule = await import("node:os");
    const spy = spyOn(osModule, "homedir");
    spy.mockReturnValue("");

    try {
      expect(() => resolveTargetRoot("~/some/path")).toThrow(
        /Unable to determine home directory/i,
      );
    } finally {
      spy.mockRestore();
      if (savedHome !== undefined) {
        process.env["HOME"] = savedHome;
      }
    }
  });
});

// ── assertSafeRoot — root-level readdir failure ────────────────────────

describe("assertSafeRoot — root readdir failure", () => {
  test("throws SkillTargetError when readdirSync fails on target root", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");
    await createSkillDir(skillsDir, "skill-a", { "SKILL.md": "# A" });

    const targetRoot = await createTempDir(tempDirs);
    const fsModule = await import("node:fs");
    const originalReaddirSync = fsModule.readdirSync;
    const spy = spyOn(fsModule, "readdirSync");
    spy.mockImplementation(((p: PathLike) => {
      const pathStr = String(p);
      if (pathStr === targetRoot) {
        const err = new Error(
          `EACCES: permission denied, scandir '${pathStr}'`,
        ) as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return originalReaddirSync(p);
    }) as typeof fsModule.readdirSync);

    try {
      expect(() =>
        computeSkillsInventory(targetRoot, { packageRoot: root }),
      ).toThrow(SkillTargetError);
      expect(() =>
        computeSkillsInventory(targetRoot, { packageRoot: root }),
      ).toThrow(/Failed to read Target root/i);
    } finally {
      spy.mockRestore();
    }
  });

  test("throws SkillSourceError when readdirSync fails on source root", async () => {
    const root = await createPackageRoot(tempDirs);
    const skillsDir = join(root, "skills");
    await createSkillDir(skillsDir, "skill-a", { "SKILL.md": "# A" });

    const targetRoot = await createTempDir(tempDirs);
    const fsModule = await import("node:fs");
    const originalReaddirSync = fsModule.readdirSync;
    const spy = spyOn(fsModule, "readdirSync");
    spy.mockImplementation(((p: PathLike) => {
      const pathStr = String(p);
      if (pathStr === skillsDir) {
        const err = new Error(
          `EACCES: permission denied, scandir '${pathStr}'`,
        ) as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return originalReaddirSync(p);
    }) as typeof fsModule.readdirSync);

    try {
      expect(() =>
        computeSkillsInventory(targetRoot, { packageRoot: root }),
      ).toThrow(SkillSourceError);
      expect(() =>
        computeSkillsInventory(targetRoot, { packageRoot: root }),
      ).toThrow(/Failed to read Skills directory/i);
    } finally {
      spy.mockRestore();
    }
  });
});
